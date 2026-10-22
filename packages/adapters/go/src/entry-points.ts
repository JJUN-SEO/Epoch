import type { EntryPoint, ProjectContext } from "@epoch-dev/core";
import { isPackageFile, isTestFile } from "./files.js";
import { dirOf, moduleIndex } from "./modules.js";

/*
 * Entry points for Go (CLAUDE.md "Unreachable files", ADR-007): `package
 * main` files, and every package other modules can import (any package of a
 * module outside an `internal/` directory), since a library's public API is
 * reachable by definition. Only `internal/` packages and packages nothing
 * but test files import can be unreachable. The package clause is read from
 * the file head as text; nothing is run.
 */

const HEAD_BYTES = 64 * 1024;

/** The package clause's name, skipping comments and blank space; undefined if none. */
export function packageClause(text: string): string | undefined {
  const s = text.slice(0, HEAD_BYTES);
  let i = s.startsWith("﻿") ? 1 : 0;
  while (i < s.length) {
    const c = s.charAt(i);
    if (c === " " || c === "\t" || c === "\r" || c === "\n") i++;
    else if (s.startsWith("//", i)) {
      const end = s.indexOf("\n", i);
      i = end === -1 ? s.length : end + 1;
    } else if (s.startsWith("/*", i)) {
      const end = s.indexOf("*/", i + 2);
      if (end === -1) return undefined;
      i = end + 2;
    } else break;
  }
  const m = /^package[ \t]+([\p{L}_][\p{L}\p{Nd}_]*)/u.exec(
    s.slice(i, i + 256),
  );
  return m?.[1];
}

export function detectEntryPoints(ctx: ProjectContext): EntryPoint[] {
  const ix = moduleIndex(ctx);
  const byDir = new Map<string, string[]>();
  for (const f of ctx.repo.files) {
    if (!isPackageFile(f) || isTestFile(f)) continue;
    const list = byDir.get(dirOf(f)) ?? [];
    list.push(f);
    byDir.set(dirOf(f), list);
  }
  const isMain = (f: string) =>
    packageClause(ctx.repo.reader.readFile(`${ctx.repo.root}/${f}`) ?? "") ===
    "main";
  const out: EntryPoint[] = [];
  for (const [dir, files] of [...byDir].sort(([a], [b]) => (a < b ? -1 : 1))) {
    const importPath = ix.importPathOf(dir);
    const first = files[0];
    if (first === undefined) continue;
    if (importPath === undefined) {
      // No module: each file is its own node.
      for (const f of files) {
        if (isMain(f))
          out.push({ file: f, reason: "convention", source: "package main" });
      }
      continue;
    }
    if (isMain(first)) {
      out.push({ file: first, reason: "convention", source: "package main" });
    } else if (!importPath.split("/").includes("internal")) {
      const mod = ix.moduleOf(dir);
      const gomod =
        mod === undefined || mod.dir === "" ? "go.mod" : `${mod.dir}/go.mod`;
      out.push({
        file: first,
        reason: "manifest",
        source: `${gomod} (importable package ${importPath})`,
      });
    }
  }
  return out;
}
