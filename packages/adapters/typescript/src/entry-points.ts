import ts from "typescript";
import type { EntryPoint, ProjectContext } from "@epoch-dev/core";
import { EXTENSIONS } from "./files.js";
import { resolveImport } from "./resolve.js";

/*
 * Entry points for TS/JS (CLAUDE.md "Unreachable files", ADR-007): the roots
 * reachability starts from. Everything is read as data: package.json and
 * tsconfig as JSON, HTML pages and `#!` lines as text; nothing is run.
 */

const dirOf = (p: string): string =>
  p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : "";
const baseOf = (p: string): string => p.slice(p.lastIndexOf("/") + 1);
const join = (dir: string, rel: string): string => {
  const parts = dir === "" ? [] : dir.split("/");
  for (const seg of rel.replace(/\\/g, "/").split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") parts.pop();
    else parts.push(seg);
  }
  return parts.join("/");
};

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** Every string target of a package.json field (`exports` and `bin` may nest). */
function targets(v: unknown): string[] {
  if (typeof v === "string") return [v];
  if (Array.isArray(v)) return v.flatMap(targets);
  if (isRecord(v)) return Object.values(v).flatMap(targets);
  return [];
}

const MANIFEST_FIELDS = [
  "main",
  "module",
  "types",
  "typings",
  "browser",
  "bin",
  "exports",
] as const;

/** Build-output extensions and the source extensions they come from. */
const SOURCE_FOR: Readonly<Record<string, readonly string[]>> = {
  ".js": [".ts", ".tsx", ".js", ".jsx"],
  ".jsx": [".tsx", ".jsx"],
  ".mjs": [".mts", ".mjs"],
  ".cjs": [".cts", ".cjs"],
  ".d.ts": [".ts", ".tsx"],
  ".d.mts": [".mts"],
  ".d.cts": [".cts"],
};

const BUNDLER_OUT_DIRS = ["dist", "lib", "build", "out", "esm", "cjs"] as const;
const ANY_SOURCE = [
  ".ts",
  ".tsx",
  ".mts",
  ".cts",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
] as const;

const CONFIG_FILE = /(?:^|\.)config\.[cm]?[jt]s$|^\.[\w-]+rc\.[cm]?[jt]s$/;
const WORKFLOW_FILE = /^\.github\/workflows\/[^/]+\.ya?ml$/;
/** Characters a path in a workflow cannot contain: whitespace, quotes, ${{ }}, ${ }, shell syntax. */
const NOT_IN_PATH = /[\s"'`(){}$,;=|&<>]+/;
const CONVENTION_FILE = /^(?:main|cli)\.[cm]?[jt]sx?$/;

interface TsconfigDirs {
  readonly outDir?: string;
  readonly rootDir?: string;
}

/** outDir and rootDir of the tsconfig in `dir`, read as JSON with comments. */
function tsconfigDirs(ctx: ProjectContext, dir: string): TsconfigDirs {
  const file = join(dir, "tsconfig.json");
  const text = ctx.repo.reader.readFile(`${ctx.repo.root}/${file}`);
  if (text === undefined) return {};
  const { config } = ts.parseConfigFileTextToJson(file, text) as {
    config?: { compilerOptions?: { outDir?: unknown; rootDir?: unknown } };
  };
  const opts = config?.compilerOptions;
  return {
    ...(typeof opts?.outDir === "string"
      ? { outDir: join(dir, opts.outDir) }
      : {}),
    ...(typeof opts?.rootDir === "string"
      ? { rootDir: join(dir, opts.rootDir) }
      : {}),
  };
}

/**
 * The source file a manifest target names: itself if it is source, else
 * mapped from tsconfig's outDir back to rootDir (or `src`) with the source
 * extension, else, without an outDir, from a bundler's usual output folder
 * (dist, lib, build, out, esm, cjs) back to `src`. Undefined when it cannot
 * be mapped.
 */
function sourceFor(
  target: string,
  files: ReadonlySet<string>,
  dirs: TsconfigDirs,
  pkgDir: string,
): string | undefined {
  if (files.has(target)) return target;
  const ext = Object.keys(SOURCE_FOR)
    .sort((a, b) => b.length - a.length)
    .find((e) => target.endsWith(e));
  if (ext === undefined) return undefined;
  const stem = target.slice(0, -ext.length);
  const outDir = dirs.outDir;
  const rootDir = dirs.rootDir ?? join(pkgDir, "src");
  for (const srcExt of SOURCE_FOR[ext] ?? []) {
    if (files.has(`${stem}${srcExt}`)) return `${stem}${srcExt}`;
  }
  if (
    outDir !== undefined &&
    (stem === outDir || stem.startsWith(`${outDir}/`))
  ) {
    const mapped = `${rootDir}${stem.slice(outDir.length)}`;
    for (const srcExt of SOURCE_FOR[ext] ?? []) {
      if (files.has(`${mapped}${srcExt}`)) return `${mapped}${srcExt}`;
    }
    return undefined;
  }
  // No tsconfig outDir: a bundler (tsup, rollup, unbuild...) usually builds
  // <pkg>/src into <pkg>/dist (or lib, build, out), any extension to any,
  // but a .cts or .mts source beside the .ts one is what a .cjs or .mjs
  // output comes from.
  for (const out of BUNDLER_OUT_DIRS) {
    const dir = join(pkgDir, out);
    if (!stem.startsWith(`${dir}/`)) continue;
    const mapped = `${join(pkgDir, "src")}${stem.slice(dir.length)}`;
    for (const srcExt of [...(SOURCE_FOR[ext] ?? []), ...ANY_SOURCE]) {
      if (files.has(`${mapped}${srcExt}`)) return `${mapped}${srcExt}`;
    }
  }
  return undefined;
}

/** `<script src="...">` values of an HTML page, by a linear scan (no regex over the page). */
function scriptSources(html: string): string[] {
  const out: string[] = [];
  const lower = html.toLowerCase();
  let at = 0;
  for (;;) {
    const open = lower.indexOf("<script", at);
    if (open === -1) break;
    const close = lower.indexOf(">", open);
    if (close === -1) break;
    const tag = html.slice(open, close);
    const i = tag.toLowerCase().indexOf("src=");
    if (i !== -1) {
      const quote = tag.charAt(i + 4);
      if (quote === '"' || quote === "'") {
        const end = tag.indexOf(quote, i + 5);
        if (end !== -1) out.push(tag.slice(i + 5, end));
      }
    }
    at = close + 1;
  }
  return out;
}

const isSource = (p: string) => EXTENSIONS.some((e) => p.endsWith(e));

const MAX_CONFIG_BYTES = 256 * 1024;

/** JSON configs of workspace tools that name entry files (Nx, Angular, NestJS). */
const JSON_TOOL_CONFIGS = new Set([
  "project.json",
  "angular.json",
  "workspace.json",
  "nest-cli.json",
]);

/** Component and page formats that import TS/JS but are not analyzed themselves. */
const TEMPLATE_FILE = /\.(?:vue|svelte|astro|mdx)$/;
const MAX_TEMPLATE_BYTES = 1024 * 1024;
/** `from "x"`, `import "x"` and `import("x")`: bounded, so linear on any input. */
const TEMPLATE_IMPORTS = [
  /(?:\bfrom|\bimport)\s{0,20}["']([^"'\n]{1,300})["']/g,
  /\bimport\s{0,20}\(\s{0,20}["']([^"'\n]{1,300})["']\s{0,20}\)/g,
];

/**
 * String literals of a config file that look like file paths, by a linear
 * scan (no regex over the file): quoted, no whitespace, no glob characters,
 * and either relative (./, ../) or containing a slash.
 */
function pathStrings(text: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < text.length; i++) {
    const q = text.charAt(i);
    // Comments are skipped, so an apostrophe in one ("don't") cannot
    // throw the quote pairing off for the rest of the file.
    if (q === "/" && text.charAt(i + 1) === "/") {
      const nl = text.indexOf("\n", i);
      if (nl === -1) break;
      i = nl;
      continue;
    }
    if (q === "/" && text.charAt(i + 1) === "*") {
      const close = text.indexOf("*/", i + 2);
      if (close === -1) break;
      i = close + 1;
      continue;
    }
    if (q !== '"' && q !== "'" && q !== "`") continue;
    const end = text.indexOf(q, i + 1);
    if (end === -1) break;
    const value = text.slice(i + 1, end);
    i = end;
    if (
      value.length > 0 &&
      value.length <= 300 &&
      !/[\s*?{}$\\]/.test(value) &&
      (value.startsWith(".") || value.includes("/")) &&
      !/^[a-z]+:/i.test(value)
    ) {
      out.push(value);
    }
  }
  return out;
}

export function detectEntryPoints(ctx: ProjectContext): EntryPoint[] {
  const files = new Set(ctx.repo.files.filter(isSource));
  const out: EntryPoint[] = [];
  const add = (file: string, reason: EntryPoint["reason"], source: string) => {
    if (files.has(file)) out.push({ file, reason, source });
  };
  for (const manifest of ctx.repo.files) {
    if (baseOf(manifest) !== "package.json") continue;
    const text = ctx.repo.reader.readFile(`${ctx.repo.root}/${manifest}`);
    if (text === undefined) continue;
    let pkg: unknown;
    try {
      pkg = JSON.parse(text);
    } catch {
      continue;
    }
    if (!isRecord(pkg)) continue;
    const dir = dirOf(manifest);
    const dirs = tsconfigDirs(ctx, dir);
    for (const field of MANIFEST_FIELDS) {
      for (const t of targets(pkg[field])) {
        const src = sourceFor(join(dir, t), files, dirs, dir);
        if (src !== undefined) add(src, "manifest", `${manifest} ${field}`);
      }
    }
    if (isRecord(pkg.scripts)) {
      for (const [name, script] of Object.entries(pkg.scripts)) {
        if (typeof script !== "string") continue;
        for (const token of script.split(/[\s;&|()<>"'=]+/)) {
          if (token === "" || token.startsWith("-")) continue;
          add(join(dir, token), "script", `${manifest} scripts.${name}`);
        }
      }
    }
  }
  // GitHub Actions workflows run scripts (`run: node scripts/x.mjs`) and
  // github-script steps import them, by paths relative to the repository root.
  // GitHub reads workflows only from the root's .github/workflows.
  for (const file of ctx.repo.files) {
    if (!WORKFLOW_FILE.test(file)) continue;
    const text = ctx.repo.reader.readFile(`${ctx.repo.root}/${file}`);
    if (text === undefined || text.length > MAX_CONFIG_BYTES) continue;
    for (const token of text.split(NOT_IN_PATH)) {
      const rel = token.replace(/^\.?\//, "");
      if (rel !== "" && isSource(rel)) add(rel, "script", file);
    }
  }
  /** Roots for the source files a config file names by path, tried against each base folder. */
  const namedPaths = (file: string, bases: readonly string[]) => {
    const text = ctx.repo.reader.readFile(`${ctx.repo.root}/${file}`);
    if (text === undefined || text.length > MAX_CONFIG_BYTES) return;
    for (const value of pathStrings(text)) {
      for (const base of bases) {
        const target = join(base, value);
        const hit = [
          target,
          ...ANY_SOURCE.map((e) => `${target}${e}`),
          ...ANY_SOURCE.map((e) => `${target}/index${e}`),
        ].find((c) => c !== file && files.has(c));
        if (hit !== undefined) {
          add(hit, "config", `${file} (names this path)`);
          break;
        }
      }
    }
  };
  // Workspace tools that name entry files in JSON (Nx, Angular, NestJS), often
  // relative to the workspace root rather than to the file itself.
  for (const file of ctx.repo.files) {
    if (JSON_TOOL_CONFIGS.has(baseOf(file)))
      namedPaths(file, [dirOf(file), ""]);
  }
  for (const file of files) {
    const base = baseOf(file);
    if (CONFIG_FILE.test(base)) {
      add(file, "config", `${base} (tool configuration)`);
      // Files a tool config names by path: build entries, setup files...
      namedPaths(file, [dirOf(file)]);
    } else if (CONVENTION_FILE.test(base))
      add(file, "convention", `${base} (entry-point name)`);
    else if (dirOf(file).split("/").at(-1) === "bin")
      add(file, "convention", "bin/ directory");
    else if (
      ctx.repo.reader.readFile(`${ctx.repo.root}/${file}`)?.startsWith("#!") ===
      true
    ) {
      add(file, "convention", "executable script (#!)");
    }
  }
  // Vue, Svelte, Astro and MDX files are not analyzed, but what they import
  // is used: their import specifiers, resolved as TS would, count as roots.
  for (const file of ctx.repo.files) {
    const ext = TEMPLATE_FILE.exec(file)?.[0];
    if (ext === undefined) continue;
    const text = ctx.repo.reader.readFile(`${ctx.repo.root}/${file}`);
    if (text === undefined || text.length > MAX_TEMPLATE_BYTES) continue;
    for (const pattern of TEMPLATE_IMPORTS) {
      for (const m of text.matchAll(pattern)) {
        const specifier = m[1];
        if (specifier === undefined) continue;
        const res = resolveImport(
          { kind: "static", specifier, typeOnly: false, names: [], line: 1 },
          file,
          ctx,
        );
        if (res.kind === "file") {
          add(
            res.target,
            "convention",
            `${file} imports it (${ext} files are not analyzed)`,
          );
        }
      }
    }
  }
  for (const page of ctx.repo.files) {
    if (!page.endsWith(".html")) continue;
    const html = ctx.repo.reader.readFile(`${ctx.repo.root}/${page}`);
    if (html === undefined || html.length > 1024 * 1024) continue;
    for (const src of scriptSources(html)) {
      if (/^[a-z]+:/i.test(src) || src.startsWith("//")) continue; // remote scripts
      const rel = src.startsWith("/")
        ? join(dirOf(page), src.slice(1))
        : join(dirOf(page), src);
      add(rel, "convention", `${page} <script>`);
    }
  }
  return out;
}
