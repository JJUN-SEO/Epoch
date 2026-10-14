import { builtinModules } from "node:module";
import path from "node:path";
import ts from "typescript";
import type {
  RawImport,
  RepoView,
  Resolution,
  ResolveContext,
} from "@epoch-dev/core";
import { ROOT_KINDS } from "./roots.js";

const CASE_INSENSITIVE =
  process.platform === "darwin" || process.platform === "win32";
const BUILTINS: ReadonlySet<string> = new Set(builtinModules);
const SOURCE_EXTENSIONS = [".ts", ".tsx", ".mts", ".cts"] as const;

/** Options for files that no tsconfig/jsconfig governs (plain JS projects). */
const DEFAULT_OPTIONS: ts.CompilerOptions = {
  allowJs: true,
  module: ts.ModuleKind.ESNext,
  moduleResolution: ts.ModuleResolutionKind.Bundler,
  resolveJsonModule: true,
  allowImportingTsExtensions: true,
  noEmit: true,
  jsx: ts.JsxEmit.Preserve,
};

const posix = (p: string): string => p.replace(/\\/g, "/");
const key = (p: string): string => (CASE_INSENSITIVE ? p.toLowerCase() : p);
const isRelative = (s: string): boolean =>
  s === "." || s === ".." || s.startsWith("./") || s.startsWith("../");
const isAbsolute = (s: string): boolean =>
  s.startsWith("/") || /^[A-Za-z]:[\\/]/.test(s);
const hasGlob = (s: string): boolean => /[*?]/.test(s);
/**
 * Resolves a relative specifier against the importing file. path.posix.join
 * normalizes without consulting process.cwd(), unlike path.posix.resolve,
 * which treats a Windows drive-letter root ("D:/repo") as relative. Like
 * resolve, it drops a trailing slash.
 */
const joinFrom = (fromAbs: string, spec: string): string =>
  path.posix.join(path.posix.dirname(fromAbs), spec).replace(/(.)\/+$/, "$1");

/** "@scope/name/sub" -> "@scope/name"; "name/sub" -> "name". */
export function packageName(specifier: string): string {
  const parts = specifier.split("/");
  return specifier.startsWith("@") && parts.length > 1
    ? `${parts[0] ?? ""}/${parts[1] ?? ""}`
    : (parts[0] ?? specifier);
}

interface ConfigInfo {
  readonly options: ts.CompilerOptions;
  readonly fileNames: ReadonlySet<string>;
  readonly references: readonly string[];
  readonly cache: ts.ModuleResolutionCache;
}

/**
 * Per-analysis resolver state, cached per ResolveContext: the read-only host,
 * parsed tsconfigs, and the workspace overlay. Everything reads through
 * ctx.repo.reader; nothing is written or executed (tsconfig is parsed as
 * JSON, its `plugins` are never loaded, and `extends` of a .js file fails to
 * parse rather than run).
 */
class Resolver {
  private readonly repo: RepoView;
  private readonly roots: readonly string[];
  private readonly files: ReadonlyMap<string, string>;
  private readonly virtual: readonly (readonly [string, string])[];
  private readonly virtualDirs: ReadonlySet<string>;
  private readonly workspaceNames: ReadonlySet<string>;
  private readonly tsconfigFiles: ReadonlySet<string>;
  private readonly configs = new Map<string, ConfigInfo | null>();
  private readonly governingCache = new Map<string, ConfigInfo>();
  private readonly outMaps: (readonly [string, readonly string[]])[] = [];
  private readonly defaultConfig: ConfigInfo;
  readonly host: ts.ModuleResolutionHost & ts.ParseConfigHost;

  constructor(ctx: ResolveContext) {
    this.repo = ctx.repo;
    const root = ctx.repo.root;
    const real = ctx.repo.reader.realpath(root);
    this.roots = real === root ? [root] : [root, real];
    this.files = new Map(ctx.repo.files.map((f) => [key(f), f]));

    const workspace = ctx.projectRoots.filter(
      (r) => r.kind === ROOT_KINDS.workspacePackage,
    );
    this.workspaceNames = new Set(
      workspace.flatMap((r) => (r.name ? [r.name] : [])),
    );
    this.virtual = workspace
      .flatMap((r) =>
        r.name
          ? [[`${root}/node_modules/${r.name}`, this.abs(r.dir)] as const]
          : [],
      )
      .sort((a, b) => b[0].length - a[0].length);
    const dirs = new Set<string>();
    for (const [from] of this.virtual) {
      for (
        let d = path.posix.dirname(from);
        d.length > root.length;
        d = path.posix.dirname(d)
      ) {
        dirs.add(key(d));
      }
    }
    this.virtualDirs = dirs;
    this.tsconfigFiles = new Set(
      ctx.projectRoots
        .filter((r) => r.kind === ROOT_KINDS.tsconfig)
        .flatMap((r) => (r.file ? [r.file] : [])),
    );

    const reader = ctx.repo.reader;
    this.host = {
      useCaseSensitiveFileNames: !CASE_INSENSITIVE,
      getCurrentDirectory: () => root,
      fileExists: (f) => {
        const m = this.vmap(f);
        return reader.fileExists(m) || this.toSource(m) !== undefined;
      },
      readFile: (f) => reader.readFile(this.vmap(f)),
      directoryExists: (d) =>
        this.virtualDirs.has(key(posix(d))) ||
        reader.directoryExists(this.vmap(d)),
      realpath: (p) => reader.realpath(this.vmap(p)),
      getDirectories: (d) => reader.getDirectories(this.vmap(d)),
      readDirectory: (dir, extensions, excludes, includes) =>
        this.readDirectory(dir, extensions, excludes, includes),
    };

    this.defaultConfig = this.makeConfig(DEFAULT_OPTIONS, [], []);
    // Parse every tsconfig up front so outDir -> rootDir maps exist before
    // any workspace import is resolved.
    for (const file of this.tsconfigFiles) this.config(this.abs(file));
  }

  abs(rel: string): string {
    return rel === "" ? this.repo.root : `${this.repo.root}/${rel}`;
  }

  /** Repo-relative path for an absolute one, or undefined if outside the root. */
  rel(abs: string): string | undefined {
    const p = posix(abs);
    const k = key(p);
    for (const r of this.roots) {
      const rk = key(r);
      if (k === rk) return "";
      if (k.startsWith(`${rk}/`)) return p.slice(r.length + 1);
    }
    return undefined;
  }

  /** Maps node_modules/<workspace-package> onto the package directory. */
  vmap(p: string): string {
    const q = posix(p);
    const k = key(q);
    for (const [from, to] of this.virtual) {
      const fk = key(from);
      if (k === fk || k.startsWith(`${fk}/`)) return to + q.slice(from.length);
    }
    return q;
  }

  /** A build output path (outDir) mapped back to its source file, if one exists. */
  toSource(p: string): string | undefined {
    const k = key(p);
    for (const [out, sourceRoots] of this.outMaps) {
      if (!k.startsWith(`${key(out)}/`)) continue;
      const stem = p
        .slice(out.length)
        .replace(/\.(?:d\.[cm]?ts|[cm]?js|jsx)$/, "");
      for (const src of sourceRoots) {
        for (const ext of SOURCE_EXTENSIONS) {
          const candidate = `${src}${stem}${ext}`;
          if (this.repo.reader.fileExists(candidate)) return candidate;
        }
      }
    }
    return undefined;
  }

  /** tsconfig include/exclude expansion over the discovered files (no extra walk). */
  private readDirectory(
    dir: string,
    extensions: readonly string[],
    excludes: readonly string[] | undefined,
    includes: readonly string[],
  ): string[] {
    const base = posix(dir);
    const toAbs = (spec: string) => {
      const s = posix(spec).replace(/\/$/, "");
      return isAbsolute(s) ? s : path.posix.join(base, s);
    };
    const include = (includes.length ? includes : ["**/*"]).map((spec) => {
      const p = toAbs(spec);
      const last = p.slice(p.lastIndexOf("/") + 1);
      return hasGlob(p) || last.includes(".") ? p : `${p}/**/*`;
    });
    const exclude = (excludes ?? []).map(toAbs);
    const out: string[] = [];
    for (const rel of this.repo.files) {
      const f = this.abs(rel);
      if (!extensions.some((e) => f.endsWith(e))) continue;
      if (!include.some((p) => f === p || path.posix.matchesGlob(f, p)))
        continue;
      if (
        exclude.some(
          (p) => f.startsWith(`${p}/`) || path.posix.matchesGlob(f, p),
        )
      )
        continue;
      out.push(f);
    }
    return out;
  }

  private makeConfig(
    options: ts.CompilerOptions,
    fileNames: readonly string[],
    references: readonly string[],
  ): ConfigInfo {
    return {
      options,
      fileNames: new Set(fileNames.map((f) => key(posix(f)))),
      references,
      cache: ts.createModuleResolutionCache(this.repo.root, key, options),
    };
  }

  /** Parses a tsconfig/jsconfig (as JSON data) once; null if unreadable. */
  config(absFile: string): ConfigInfo | null {
    const cached = this.configs.get(absFile);
    if (cached !== undefined) return cached;
    this.configs.set(absFile, null); // guards against reference cycles
    const read = ts.readConfigFile(absFile, (p) => this.host.readFile(p));
    if (read.error) return null;
    const dir = path.posix.dirname(absFile);
    const parsed = ts.parseJsonConfigFileContent(
      read.config,
      this.host,
      dir,
      undefined,
      absFile,
    );
    const info = this.makeConfig(
      parsed.options,
      parsed.fileNames,
      (parsed.projectReferences ?? []).map((r) =>
        posix(ts.resolveProjectReferencePath(r)),
      ),
    );
    if (parsed.options.outDir) {
      const out = posix(parsed.options.outDir);
      const sources = parsed.options.rootDir
        ? [posix(parsed.options.rootDir)]
        : [`${dir}/src`, dir];
      this.outMaps.push([out, sources]);
    }
    this.configs.set(absFile, info);
    return info;
  }

  private includes(
    cfg: ConfigInfo,
    fileKey: string,
    seen: Set<ConfigInfo>,
  ): ConfigInfo | undefined {
    if (seen.has(cfg)) return undefined;
    seen.add(cfg);
    if (cfg.fileNames.has(fileKey)) return cfg;
    for (const ref of cfg.references) {
      const r = this.config(ref);
      const hit = r ? this.includes(r, fileKey, seen) : undefined;
      if (hit) return hit;
    }
    return undefined;
  }

  /**
   * The governing config: the nearest tsconfig.json (or jsconfig.json) whose
   * file list contains the file, following solution-style `references`; else
   * the nearest one; else defaults for config-less JS.
   */
  governing(fromRel: string): ConfigInfo {
    const hit = this.governingCache.get(fromRel);
    if (hit) return hit;
    const candidates: ConfigInfo[] = [];
    let dir = path.posix.dirname(fromRel);
    for (;;) {
      const d = dir === "." ? "" : dir;
      for (const name of ["tsconfig.json", "jsconfig.json"]) {
        const file = d === "" ? name : `${d}/${name}`;
        if (!this.tsconfigFiles.has(file)) continue;
        const cfg = this.config(this.abs(file));
        if (cfg) candidates.push(cfg);
        break;
      }
      if (d === "") break;
      dir = path.posix.dirname(d);
    }
    const fileKey = key(this.abs(fromRel));
    let chosen: ConfigInfo | undefined;
    for (const c of candidates) {
      chosen = this.includes(c, fileKey, new Set());
      if (chosen) break;
    }
    const result = chosen ?? candidates[0] ?? this.defaultConfig;
    this.governingCache.set(fromRel, result);
    return result;
  }

  /** A discovered file -> file resolution; on disk but not analyzed -> outside-project. */
  private fileTarget(rel: string): Resolution {
    const found = this.files.get(key(rel));
    return found !== undefined
      ? { kind: "file", target: found }
      : { kind: "unresolved", reason: "outside-project" };
  }

  private matchesPaths(spec: string, options: ts.CompilerOptions): boolean {
    for (const pattern of Object.keys(options.paths ?? {})) {
      const star = pattern.indexOf("*");
      if (
        star === -1
          ? spec === pattern
          : spec.startsWith(pattern.slice(0, star)) &&
            spec.endsWith(pattern.slice(star + 1))
      ) {
        return true;
      }
    }
    return false;
  }

  private dynamicPrefix(
    prefix: string | undefined,
    fromAbs: string,
  ): string | undefined {
    if (prefix === undefined || !(isRelative(prefix) || isAbsolute(prefix)))
      return undefined;
    const target = isAbsolute(prefix)
      ? posix(prefix)
      : joinFrom(fromAbs, prefix);
    const rel = this.rel(target);
    if (rel === undefined) return undefined;
    return prefix.endsWith("/") && rel !== "" ? `${rel}/` : rel;
  }

  resolve(imp: RawImport, fromRel: string): Resolution {
    const fromAbs = this.abs(fromRel);
    if (imp.specifier === null) {
      const prefix = this.dynamicPrefix(imp.dynamicPrefix, fromAbs);
      return prefix === undefined
        ? { kind: "unresolved", reason: "dynamic-specifier" }
        : {
            kind: "unresolved",
            reason: "dynamic-specifier",
            pathPrefix: prefix,
          };
    }
    const spec = imp.specifier;
    const cfg = this.governing(fromRel);
    const mode =
      imp.kind === "require"
        ? ts.ModuleKind.CommonJS
        : imp.kind === "dynamic"
          ? ts.ModuleKind.ESNext
          : (ts.getImpliedNodeFormatForFile(
              fromAbs,
              cfg.cache.getPackageJsonInfoCache(),
              this.host,
              cfg.options,
            ) ?? ts.ModuleKind.ESNext);
    const resolved = ts.resolveModuleName(
      spec,
      fromAbs,
      cfg.options,
      this.host,
      cfg.cache,
      undefined,
      mode,
    ).resolvedModule;

    if (resolved) {
      const mapped = this.vmap(resolved.resolvedFileName);
      const real =
        this.host.realpath?.(this.toSource(mapped) ?? mapped) ?? mapped;
      const rel = this.rel(real);
      if (rel !== undefined && !rel.split("/").includes("node_modules"))
        return this.fileTarget(rel);
      if (rel === undefined && !real.split("/").includes("node_modules")) {
        return { kind: "unresolved", reason: "outside-project" };
      }
      return {
        kind: "external",
        name: resolved.packageId?.name ?? packageName(spec),
      };
    }

    if (spec.startsWith("node:") || BUILTINS.has(spec)) {
      return { kind: "external", name: `node:${spec.replace(/^node:/, "")}` };
    }
    if (isRelative(spec) || isAbsolute(spec)) {
      const target = isAbsolute(spec) ? posix(spec) : joinFrom(fromAbs, spec);
      const rel = this.rel(target);
      if (rel === undefined)
        return { kind: "unresolved", reason: "outside-project" };
      // Imports of non-source files (JSON, CSS, images) that exist in the repo.
      if (this.files.has(key(rel))) return this.fileTarget(rel);
      if (this.repo.reader.fileExists(target))
        return { kind: "unresolved", reason: "outside-project" };
      return { kind: "unresolved", reason: "not-found" };
    }
    if (
      this.matchesPaths(spec, cfg.options) ||
      this.workspaceNames.has(packageName(spec))
    ) {
      return { kind: "unresolved", reason: "not-found" };
    }
    return { kind: "external", name: packageName(spec) };
  }
}

const resolvers = new WeakMap<ResolveContext, Resolver>();

/**
 * resolveImport for TS/JS: TypeScript's own module resolution (tsconfig
 * paths/baseUrl, package.json exports, .js -> .ts mapping, directory index)
 * over a read-only host. Workspace packages resolve to their source even
 * without node_modules; third-party packages become externals; everything
 * else is unresolved with a reason. Never silently drops an import.
 */
export function resolveImport(
  imp: RawImport,
  from: string,
  ctx: ResolveContext,
): Resolution {
  let r = resolvers.get(ctx);
  if (!r) {
    r = new Resolver(ctx);
    resolvers.set(ctx, r);
  }
  return r.resolve(imp, from);
}
