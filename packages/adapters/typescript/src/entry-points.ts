import ts from "typescript";
import type { EntryPoint, ProjectContext } from "@epoch-dev/core";
import { EXTENSIONS } from "./files.js";

/*
 * Entry points for TS/JS (CLAUDE.md "Unreachable files", ADR-007): the roots
 * reachability starts from. Everything is read as data: package.json and
 * tsconfig as JSON, index.html as text; nothing is run.
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

const CONFIG_FILE = /(?:^|\.)config\.[cm]?[jt]s$|^\.[\w-]+rc\.[cm]?[jt]s$/;
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
 * extension. Undefined when it cannot be mapped.
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
  const candidates = [stem];
  if (
    outDir !== undefined &&
    (stem === outDir || stem.startsWith(`${outDir}/`))
  ) {
    candidates.push(`${rootDir}${stem.slice(outDir.length)}`);
  }
  for (const c of candidates) {
    for (const srcExt of SOURCE_FOR[ext] ?? []) {
      if (files.has(`${c}${srcExt}`)) return `${c}${srcExt}`;
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
  for (const file of files) {
    const base = baseOf(file);
    if (CONFIG_FILE.test(base))
      add(file, "config", `${base} (tool configuration)`);
    else if (CONVENTION_FILE.test(base))
      add(file, "convention", `${base} (entry-point name)`);
    else if (dirOf(file).split("/").at(-1) === "bin")
      add(file, "convention", "bin/ directory");
  }
  for (const page of ctx.repo.files) {
    if (baseOf(page) !== "index.html") continue;
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
