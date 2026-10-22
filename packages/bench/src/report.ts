import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { FsReader, readHeadCommit, toPosix } from "@epoch-dev/engine";

/** Hardware and runtime, recorded with every benchmark (PLAN.md Benchmark protocol). */
export function hostInfo(): string {
  const cpus = os.cpus();
  return `${os.platform()} ${os.arch()} (${os.release()}), ${String(cpus.length)} × ${cpus[0]?.model.trim() ?? "unknown CPU"}, ${(os.totalmem() / 1024 ** 3).toFixed(0)} GiB RAM, Node ${process.versions.node}`;
}

export interface RepoInfo {
  readonly name: string;
  readonly root: string;
  readonly commit: string | null;
  readonly url: string | null;
}

/** Name, commit (from .git files, no process) and origin URL of a benchmark checkout. */
export function repoInfo(dir: string): RepoInfo {
  const root = toPosix(path.resolve(dir));
  const reader = new FsReader(root);
  const config = reader.readFile(`${root}/.git/config`) ?? "";
  const url =
    /\[remote "origin"\][^[]*?url\s*=\s*(\S+)/.exec(config)?.[1] ?? null;
  return {
    name: path.basename(root),
    root,
    commit: readHeadCommit(reader, root),
    url,
  };
}

/** A dependency's version from the package.json above its resolved entry point. */
export function installedVersion(specifier: string, name: string): string {
  let dir = path.dirname(fileURLToPath(import.meta.resolve(specifier)));
  for (;;) {
    const file = path.join(dir, "package.json");
    if (fs.existsSync(file)) {
      const pkg: unknown = JSON.parse(fs.readFileSync(file, "utf8"));
      if (
        typeof pkg === "object" &&
        pkg !== null &&
        "name" in pkg &&
        pkg.name === name &&
        "version" in pkg &&
        typeof pkg.version === "string"
      ) {
        return pkg.version;
      }
    }
    const parent = path.dirname(dir);
    if (parent === dir) return "unknown";
    dir = parent;
  }
}

export const median = (xs: readonly number[]): number => {
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length === 0
    ? Number.NaN
    : s.length % 2
      ? (s[mid] ?? 0)
      : ((s[mid - 1] ?? 0) + (s[mid] ?? 0)) / 2;
};

export const pct = (x: number): string => `${(x * 100).toFixed(1)}%`;

/** A markdown table; cells are escaped for pipes. */
export function table(
  header: readonly string[],
  rows: readonly (readonly string[])[],
): string {
  const esc = (c: string) => c.replace(/\|/g, "\\|");
  return [
    `| ${header.map(esc).join(" | ")} |`,
    `| ${header.map(() => "---").join(" | ")} |`,
    ...rows.map((r) => `| ${r.map(esc).join(" | ")} |`),
  ].join("\n");
}

export function writeReport(file: string, text: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text.endsWith("\n") ? text : `${text}\n`);
}
