/**
 * ADR-003 measurement: our syntactic barrel tracing (core buildGraph over
 * tree-sitter facts) against the TypeScript checker (ts.Program +
 * getAliasedSymbol). Both sides use the same module resolution (our TS
 * adapter), so any difference comes from tracing alone.
 *
 *   node dist/bench/barrel-compare.js ours    <repo> <out.json>
 *   node dist/bench/barrel-compare.js checker <repo> <out.json>
 *   node dist/bench/barrel-compare.js compare <ours.json> <checker.json>
 *
 * Run each side in its own process so peak RSS is per approach. Reads the
 * repo through the root-confined FsReader; never writes into it and never
 * executes its code. Output files are the caller's (scratch) paths.
 */
import fs from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";
import ts from "typescript";
import type { RawImport, RepoView, ResolveContext } from "@epoch-dev/core";
import {
  typescriptAdapter,
  typescriptRegistration,
} from "@epoch-dev/adapter-typescript";
import { FsReader, analyze, discover } from "@epoch-dev/engine";

/** A traced dependency: `from` imports names through barrel `barrel` that are declared in `target`. */
interface Triple {
  from: string;
  barrel: string;
  target: string;
}

interface SideResult {
  approach: "ours" | "checker";
  timingsMs: Record<string, number>;
  peakRssKb: number;
  triples: Triple[];
  /** checker only: bindings the checker could not trace to one repo file, by reason. */
  untraced?: Record<string, number>;
  /** checker only: per checker-traced triple, the names involved and whether B has `export ... from` for them. */
  notes?: Record<string, { names: string[]; viaExportFrom: boolean }>;
  /** checker only: every named or default binding imported from a repo file, with the checker's answer. */
  bindings?: { from: string; barrel: string; name: string; result: string }[];
}

const key = (t: Triple) => `${t.from}\u0000${t.barrel}\u0000${t.target}`;
const byKey = (a: Triple, b: Triple) =>
  key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0;
const peakRssKb = () => process.resourceUsage().maxRSS;

async function ours(repoDir: string): Promise<SideResult> {
  const { graph, meta } = await analyze(repoDir, { history: false });
  const triples: Triple[] = [];
  for (const e of graph.edges) {
    for (const ev of e.evidence) {
      if (ev.startsWith("via barrel ")) {
        triples.push({
          from: e.source,
          barrel: ev.slice("via barrel ".length),
          target: e.target,
        });
      }
    }
  }
  const unique = new Map(triples.map((t) => [key(t), t]));
  return {
    approach: "ours",
    timingsMs: { ...meta.timingsMs },
    peakRssKb: peakRssKb(),
    triples: [...unique.values()].sort(byKey),
  };
}

const SOURCE_EXTENSIONS: readonly [string, ts.Extension][] = [
  [".d.mts", ts.Extension.Dmts],
  [".d.cts", ts.Extension.Dcts],
  [".d.ts", ts.Extension.Dts],
  [".mts", ts.Extension.Mts],
  [".cts", ts.Extension.Cts],
  [".tsx", ts.Extension.Tsx],
  [".ts", ts.Extension.Ts],
  [".mjs", ts.Extension.Mjs],
  [".cjs", ts.Extension.Cjs],
  [".jsx", ts.Extension.Jsx],
  [".js", ts.Extension.Js],
];
const extensionOf = (file: string) =>
  SOURCE_EXTENSIONS.find(([ext]) => file.endsWith(ext))?.[1];

function checker(repoDir: string): SideResult {
  const t0 = performance.now();
  const found = discover(repoDir, {
    isSource: (rel) => typescriptRegistration.grammarFor(rel) !== undefined,
  });
  const reader = new FsReader(found.root);
  const repo: RepoView = { root: found.root, files: found.files, reader };
  const ctx: ResolveContext = {
    repo,
    projectRoots: typescriptAdapter.detectProjectRoots(repo),
  };
  const abs = (rel: string) => `${found.root}/${rel}`;
  const rel = (file: string) =>
    file.startsWith(`${found.root}/`)
      ? file.slice(found.root.length + 1)
      : undefined;
  const resolveTo = (
    specifier: string,
    fromRel: string,
  ): string | undefined => {
    const imp: RawImport = {
      kind: "static",
      specifier,
      typeOnly: false,
      names: [],
      line: 1,
    };
    const res = typescriptAdapter.resolveImport(imp, fromRel, ctx);
    return res.kind === "file" ? res.target : undefined;
  };
  const sources = found.files.filter(
    (f) => typescriptRegistration.grammarFor(f) !== undefined,
  );
  const t1 = performance.now();

  const options: ts.CompilerOptions = {
    allowJs: true,
    checkJs: false,
    noEmit: true,
    noLib: true,
    types: [],
    skipLibCheck: true,
    jsx: ts.JsxEmit.Preserve,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    target: ts.ScriptTarget.ESNext,
    allowImportingTsExtensions: true,
  };
  const host: ts.CompilerHost = {
    getSourceFile: (fileName, languageVersion) => {
      const text = reader.readFile(fileName);
      return text === undefined
        ? undefined
        : ts.createSourceFile(fileName, text, languageVersion);
    },
    getDefaultLibFileName: () => "lib.d.ts", // noLib: never read
    writeFile: () => {
      throw new Error("barrel-compare never writes");
    },
    getCurrentDirectory: () => found.root,
    getCanonicalFileName: (f) => f,
    useCaseSensitiveFileNames: () => true,
    getNewLine: () => "\n",
    fileExists: (f) => reader.fileExists(f),
    readFile: (f) => reader.readFile(f),
    directoryExists: (d) => reader.directoryExists(d),
    getDirectories: (d) => reader.getDirectories(d),
    realpath: (p) => reader.realpath(p),
    // Same resolution as our pipeline, so only tracing differs.
    resolveModuleNameLiterals: (literals, containingFile) =>
      literals.map((lit) => {
        const fromRel = rel(containingFile);
        const target =
          fromRel === undefined ? undefined : resolveTo(lit.text, fromRel);
        const extension =
          target === undefined ? undefined : extensionOf(target);
        return {
          resolvedModule:
            target === undefined || extension === undefined
              ? undefined
              : {
                  resolvedFileName: abs(target),
                  extension,
                  isExternalLibraryImport: false,
                },
        };
      }),
    resolveTypeReferenceDirectiveReferences: (refs) =>
      refs.map(() => ({ resolvedTypeReferenceDirective: undefined })),
  };
  const program = ts.createProgram({
    rootNames: sources.map(abs),
    options,
    host,
  });
  const tc = program.getTypeChecker();
  const t2 = performance.now();

  const triples = new Map<string, Triple>();
  const notes: Record<string, { names: string[]; viaExportFrom: boolean }> = {};
  const untraced: Record<string, number> = {};
  const bindingResults: NonNullable<SideResult["bindings"]> = [];
  let current = { from: "", barrel: "", name: "" };
  const record = (result: string) =>
    bindingResults.push({ ...current, result });
  const bump = (reason: string) => {
    untraced[reason] = (untraced[reason] ?? 0) + 1;
    record(`untraced:${reason}`);
  };
  /** Names B re-exports with `export ... from` or `export *` (syntactic barrel). */
  const exportFromNames = new Map<
    string,
    { names: Set<string>; star: boolean }
  >();
  const barrelInfo = (barrelRel: string) => {
    let info = exportFromNames.get(barrelRel);
    if (info) return info;
    info = { names: new Set(), star: false };
    const sf = program.getSourceFile(abs(barrelRel));
    for (const st of sf?.statements ?? []) {
      if (!ts.isExportDeclaration(st) || st.moduleSpecifier === undefined)
        continue;
      const clause = st.exportClause;
      if (clause === undefined) info.star = true;
      else if (ts.isNamespaceExport(clause)) info.names.add(clause.name.text);
      else for (const el of clause.elements) info.names.add(el.name.text);
    }
    exportFromNames.set(barrelRel, info);
    return info;
  };

  for (const fromRel of sources) {
    const sf = program.getSourceFile(abs(fromRel));
    if (!sf) continue;
    for (const st of sf.statements) {
      if (!ts.isImportDeclaration(st) || st.importClause === undefined)
        continue;
      if (!ts.isStringLiteral(st.moduleSpecifier)) continue;
      const clause = st.importClause;
      const barrel = resolveTo(st.moduleSpecifier.text, fromRel);
      if (barrel === undefined) continue;
      const bindings: [ts.Identifier, string][] = [];
      if (clause.name) bindings.push([clause.name, "default"]);
      const nb = clause.namedBindings;
      if (nb && ts.isNamedImports(nb)) {
        for (const el of nb.elements) {
          bindings.push([el.name, (el.propertyName ?? el.name).text]);
        }
      }
      for (const [id, imported] of bindings) {
        current = { from: fromRel, barrel, name: imported };
        const sym = tc.getSymbolAtLocation(id);
        if (!sym) {
          bump("no-symbol");
          continue;
        }
        const target =
          sym.flags & ts.SymbolFlags.Alias ? tc.getAliasedSymbol(sym) : sym;
        const files = new Set(
          (target.declarations ?? []).map((d) => d.getSourceFile().fileName),
        );
        if (files.size === 0) {
          bump("unknown-symbol");
          continue;
        }
        if (files.size > 1) {
          bump("declared-in-several-files");
          continue;
        }
        const [file] = files;
        const targetRel = file === undefined ? undefined : rel(file);
        if (targetRel === undefined) {
          bump("declared-outside-repo");
          continue;
        }
        record(targetRel);
        if (targetRel === barrel) continue; // declared in B itself: no traced edge
        const t: Triple = { from: fromRel, barrel, target: targetRel };
        triples.set(key(t), t);
        const info = barrelInfo(barrel);
        const note = (notes[key(t)] ??= { names: [], viaExportFrom: false });
        note.names.push(imported);
        if (info.star || info.names.has(imported)) note.viaExportFrom = true;
      }
    }
  }
  const t3 = performance.now();
  return {
    approach: "checker",
    timingsMs: {
      discoverAndRoots: t1 - t0,
      createProgramAndChecker: t2 - t1,
      queries: t3 - t2,
      total: t3 - t0,
    },
    peakRssKb: peakRssKb(),
    triples: [...triples.values()].sort(byKey),
    untraced,
    notes,
    bindings: bindingResults,
  };
}

function compare(oursFile: string, checkerFile: string): unknown {
  const a = JSON.parse(fs.readFileSync(oursFile, "utf8")) as SideResult;
  const b = JSON.parse(fs.readFileSync(checkerFile, "utf8")) as SideResult;
  const ka = new Map(a.triples.map((t) => [key(t), t]));
  const kb = new Map(b.triples.map((t) => [key(t), t]));
  const both = [...ka.keys()].filter((k) => kb.has(k));
  const oursOnly = [...ka.values()].filter((t) => !kb.has(key(t)));
  const checkerOnly = [...kb.values()].filter((t) => !ka.has(key(t)));
  const checkerOnlyByShape: Record<string, number> = {};
  for (const t of checkerOnly) {
    const shape =
      b.notes?.[key(t)]?.viaExportFrom === true
        ? "barrel uses export-from (our trace stopped)"
        : "barrel re-exports an imported binding (import then export)";
    checkerOnlyByShape[shape] = (checkerOnlyByShape[shape] ?? 0) + 1;
  }
  return {
    ours: {
      timingsMs: a.timingsMs,
      peakRssKb: a.peakRssKb,
      triples: a.triples.length,
    },
    checker: {
      timingsMs: b.timingsMs,
      peakRssKb: b.peakRssKb,
      triples: b.triples.length,
      untraced: b.untraced,
    },
    agreement: {
      both: both.length,
      oursOnly: oursOnly.length,
      checkerOnly: checkerOnly.length,
      jaccard:
        both.length / (both.length + oursOnly.length + checkerOnly.length || 1),
      checkerOnlyByShape,
    },
    oursOnly,
    checkerOnly: checkerOnly.map((t) => ({ ...t, ...b.notes?.[key(t)] })),
  };
}

async function main(argv: readonly string[]): Promise<void> {
  const [mode, x, y] = argv;
  if (mode === "compare" && x !== undefined && y !== undefined) {
    process.stdout.write(`${JSON.stringify(compare(x, y), null, 2)}\n`);
    return;
  }
  if (
    (mode === "ours" || mode === "checker") &&
    x !== undefined &&
    y !== undefined
  ) {
    const result = mode === "ours" ? await ours(x) : checker(x);
    fs.writeFileSync(path.resolve(y), `${JSON.stringify(result, null, 2)}\n`);
    process.stdout.write(
      `${mode}: ${String(result.triples.length)} traced triples, ${JSON.stringify(result.timingsMs)}, peak RSS ${String(result.peakRssKb)} KB\n`,
    );
    return;
  }
  process.stderr.write(
    "usage: barrel-compare (ours|checker) <repo> <out.json> | compare <ours.json> <checker.json>\n",
  );
  process.exitCode = 1;
}

await main(process.argv.slice(2));
