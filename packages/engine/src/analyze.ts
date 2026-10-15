import { performance } from "node:perf_hooks";
import type { Tree } from "web-tree-sitter";
import {
  AnalysisMeta,
  CERTAIN_EDGE_KINDS,
  EMPTY_EXTRACTOR_CONFIG,
  FileFacts,
  GRAPH_SCHEMA_VERSION,
  Graph,
  Resolution,
  buildGraph,
  stronglyConnectedComponents,
  type AdapterRegistration,
  type CacheStore,
  type CachedFacts,
  type FileInput,
  type ManifestEntry,
  type Progress,
  type RawImport,
  type RepoView,
  type ResolveContext,
  type SkipReason,
} from "@epoch-dev/core";
import {
  PARSER_FINGERPRINT,
  extractorConfigHash,
  factsKey,
  sha256,
} from "./cache/keys.js";
import { nowNs, scanChanges } from "./changes.js";
import { discover } from "./discover.js";
import { extractFile, type ExtractedFile } from "./extract-file.js";
import { readHeadCommit, type GitRunner } from "./git.js";
import { Parsers } from "./parse.js";
import type { ParsePool } from "./pool.js";
import { FsReader } from "./reader.js";
import { ChurnMemo, loadCoverage, scoreGraph } from "./score.js";
import { DEFAULT_REGISTRATIONS } from "./registrations.js";
import manifest from "../package.json" with { type: "json" };

export interface AnalyzeOptions {
  readonly onProgress?: (p: Progress) => void;
  /** Adapters to run; defaults to every built-in adapter. */
  readonly registrations?: readonly AdapterRegistration<Tree>[];
  readonly maxFileBytes?: number;
  /**
   * FileFacts cache and per-repo index (ADR-004). Without one, every file is
   * read and parsed. Resolution and the graph are recomputed either way.
   */
  readonly cache?: CacheStore;
  /** Repo-relative files to re-read even if the manifest vouches for them (--since). */
  readonly forceReread?: ReadonlySet<string>;
  /**
   * Parse workers for large batches of cache misses. Without one, or for a
   * batch under its minBatch, or with custom registrations, files parse
   * in-process. The facts are identical either way.
   */
  readonly pool?: ParsePool;
  /** Called with every import's resolution (benchmarks and debugging tools). */
  readonly onResolution?: (
    from: string,
    imp: RawImport,
    res: Resolution,
  ) => void;
  /**
   * Git churn and the risk score (default on): a git repository at the root
   * gets metrics.churn90d and metrics.riskScore. Off for runs that must not
   * depend on history (performance benchmarks).
   */
  readonly history?: boolean;
  /** Reuses churn across runs on the same HEAD (the watcher). */
  readonly churnMemo?: ChurnMemo;
  /** Runs git (tests inject one). */
  readonly git?: GitRunner;
  /**
   * A coverage report to use instead of looking for one in the project
   * (absolute path; CLI --coverage).
   */
  readonly coverageFile?: string;
}

export interface AnalyzeResult {
  readonly graph: Graph;
  readonly meta: AnalysisMeta;
}

export { DEFAULT_REGISTRATIONS };

// A JSON import, not a file read relative to this module, so the version
// survives bundling into the desktop app.
const EPOCH_VERSION: string = manifest.version;

/** Non-blank lines, CRLF-safe; binary files (any NUL byte) count as 0. */
function countBytesLoc(bytes: Buffer): number {
  if (bytes.includes(0)) return 0;
  return bytes
    .toString("utf8")
    .split(/\r\n|\r|\n/)
    .filter((l) => l.trim() !== "").length;
}

/** GraphNode.language for a non-source file: its lowercase extension. */
function assetLanguage(rel: string): string {
  const base = rel.slice(rel.lastIndexOf("/") + 1);
  const dot = base.lastIndexOf(".");
  return dot > 0 ? base.slice(dot + 1).toLowerCase() : "file";
}

interface SourceFile {
  readonly rel: string;
  readonly reg: AdapterRegistration<Tree>;
  readonly contentHash: string;
  readonly facts: FileFacts;
  /** The syntax tree had errors, so the facts are best-effort. */
  readonly partial: boolean;
}

/**
 * Runs the pipeline on a project folder: Discover, Parse, Extract (cached),
 * Resolve, Graph (CLAUDE.md "Pipeline", stages 1-5). With a cache, unchanged
 * files are neither read nor parsed; resolution and the graph are recomputed
 * every run from the (cached) facts (ADR-004). Reads the project only
 * through a FsReader confined to the root, never writes into it, and never
 * executes its code or config. Returns the canonical Graph plus the run's
 * metadata (timings, counts, skipped files, files with syntax errors,
 * cycles), which stays outside it.
 */
export async function analyze(
  rootDir: string,
  opts: AnalyzeOptions = {},
): Promise<AnalyzeResult> {
  const registrations = opts.registrations ?? DEFAULT_REGISTRATIONS;
  const progress = (stage: Progress["stage"], done: number, total: number) =>
    opts.onProgress?.({ stage, done, total });
  const regFor = (rel: string) =>
    registrations.find((r) => r.grammarFor(rel) !== undefined);
  const t0 = performance.now();

  // 1. Discover
  progress("discover", 0, 1);
  const found = discover(rootDir, {
    isSource: (rel) => regFor(rel) !== undefined,
    ...(opts.maxFileBytes !== undefined
      ? { maxFileBytes: opts.maxFileBytes }
      : {}),
  });
  const reader = new FsReader(found.root);
  const repo: RepoView = { root: found.root, files: found.files, reader };
  const skipped: { path: string; reason: SkipReason }[] = [...found.skipped];
  const abs = (rel: string) => `${found.root}/${rel}`;
  progress("discover", 1, 1);
  const t1 = performance.now();

  // 2. Change detection: reuse manifest hashes, then cached facts
  const sourceRels = found.files.filter((rel) => regFor(rel) !== undefined);
  const cache = opts.cache;
  const scanStartedNs = nowNs();
  const scan = scanChanges(
    reader,
    found.root,
    sourceRels,
    cache?.getRepoIndex(found.root),
    opts.forceReread,
  );
  for (const rel of scan.unreadable)
    skipped.push({ path: rel, reason: "unreadable" });
  const configHash = extractorConfigHash(EMPTY_EXTRACTOR_CONFIG);
  const keyFor = (reg: AdapterRegistration<Tree>, contentHash: string) =>
    factsKey({
      contentHash,
      adapterId: reg.adapter.id,
      adapterVersion: reg.adapter.version,
      parserFingerprint: PARSER_FINGERPRINT,
      extractorConfigHash: configHash,
    });
  const sources: SourceFile[] = [];
  const manifest: ManifestEntry[] = [];
  const misses: {
    rel: string;
    reg: AdapterRegistration<Tree>;
    entry: ManifestEntry;
    bytes?: Buffer;
  }[] = [];
  const lookup = () => {
    for (const [rel, state] of scan.files) {
      const reg = regFor(rel);
      if (reg === undefined) continue;
      const cached = cache?.getFacts(keyFor(reg, state.entry.contentHash));
      if (cached) {
        sources.push({
          rel,
          reg,
          contentHash: state.entry.contentHash,
          facts: cached.facts,
          partial: cached.syntaxErrors,
        });
        manifest.push(state.entry);
      } else {
        misses.push({
          rel,
          reg,
          entry: state.entry,
          ...(state.bytes ? { bytes: state.bytes } : {}),
        });
      }
    }
  };
  if (cache) cache.transaction(lookup);
  else lookup();
  const cacheHits = sources.length;
  const t2 = performance.now();

  // 3. Parse and Extract the misses only (grammars load only when needed).
  // Files are read here, through the confined reader, in either mode.
  const fresh: { key: string; value: CachedFacts }[] = [];
  const work: {
    rel: string;
    reg: AdapterRegistration<Tree>;
    grammar: string;
    bytes: Buffer;
    entry: ManifestEntry;
  }[] = [];
  for (const m of misses) {
    const grammar = m.reg.grammarFor(m.rel);
    if (grammar === undefined) continue;
    const bytes = m.bytes ?? reader.readBytes(abs(m.rel));
    if (bytes === undefined) {
      skipped.push({ path: m.rel, reason: "unreadable" });
      continue;
    }
    // Read late (an evicted entry): key by what was actually read.
    const entry =
      m.bytes === undefined
        ? { ...m.entry, size: bytes.length, contentHash: sha256(bytes) }
        : m.entry;
    work.push({ rel: m.rel, reg: m.reg, grammar, bytes, entry });
  }
  if (work.length > 0) {
    progress("parse", 0, work.length);
    let parsed = 0;
    const tick = () => {
      progress("parse", ++parsed, work.length);
    };
    const pool = opts.pool;
    const results: (ExtractedFile | undefined)[] = [];
    if (
      pool !== undefined &&
      work.length >= pool.minBatch &&
      work.every((w) => DEFAULT_REGISTRATIONS.includes(w.reg))
    ) {
      // Batches of one adapter's files, in work order.
      const batches: number[][] = [];
      for (const [i, w] of work.entries()) {
        const last = batches.at(-1);
        const head = last?.[0];
        if (
          last !== undefined &&
          head !== undefined &&
          last.length < pool.batchSize &&
          work[head]?.reg === w.reg
        ) {
          last.push(i);
        } else {
          batches.push([i]);
        }
      }
      await Promise.all(
        batches.map(async (batch) => {
          const files = batch.flatMap((i) => {
            const w = work[i];
            return w
              ? [{ rel: w.rel, grammar: w.grammar, bytes: w.bytes }]
              : [];
          });
          const adapterId = work[batch[0] ?? 0]?.reg.adapter.id ?? "";
          const out = await pool.run({ adapterId, files });
          for (const [j, i] of batch.entries()) {
            results[i] = out[j];
            tick();
          }
        }),
      );
    } else {
      const parsers = await Parsers.load(new Set(work.map((w) => w.grammar)));
      try {
        for (const w of work) {
          results.push(
            extractFile(
              parsers,
              (file, cfg) => w.reg.adapter.extract(file, cfg),
              w.rel,
              w.grammar,
              w.bytes,
            ),
          );
          tick();
        }
      } finally {
        parsers.dispose();
      }
    }
    for (const [i, w] of work.entries()) {
      const r = results[i];
      if (r === undefined) continue;
      sources.push({
        rel: w.rel,
        reg: w.reg,
        contentHash: w.entry.contentHash,
        facts: r.facts,
        partial: r.syntaxErrors,
      });
      manifest.push(w.entry);
      fresh.push({ key: keyFor(w.reg, w.entry.contentHash), value: r });
    }
  }
  if (cache && fresh.length > 0) {
    cache.transaction(() => {
      for (const f of fresh) cache.putFacts(f.key, f.value);
    });
  }
  sources.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));
  const t3 = performance.now();

  // 4. Resolve (recomputed every run: resolution depends on the whole repo)
  progress("resolve", 0, sources.length);
  const contexts = new Map<AdapterRegistration<Tree>, ResolveContext>();
  const contextFor = (reg: AdapterRegistration<Tree>): ResolveContext => {
    let ctx = contexts.get(reg);
    if (!ctx) {
      ctx = { repo, projectRoots: reg.adapter.detectProjectRoots(repo) };
      contexts.set(reg, ctx);
    }
    return ctx;
  };
  const analyzed = new Set(sources.map((s) => s.rel));
  // Package membership (ADR-013): a package exists when an analyzed
  // production file belongs to it.
  const packageOf = new Map<string, { id: string; member: boolean }>();
  const members = new Map<string, string[]>();
  for (const s of sources) {
    const pkg = s.reg.packageFor?.(s.rel, contextFor(s.reg));
    if (pkg === undefined) continue;
    packageOf.set(s.rel, pkg);
    if (pkg.member)
      members.set(pkg.id, [...(members.get(pkg.id) ?? []), s.rel]);
  }
  const assets = new Map<string, FileInput | null>();
  /** A leaf node for a resolved non-source file (JSON, CSS, images), or null if unreadable. */
  const assetFor = (rel: string): FileInput | null => {
    let asset = assets.get(rel);
    if (asset === undefined) {
      const bytes = reader.readBytes(abs(rel));
      asset =
        bytes === undefined
          ? null
          : {
              id: rel,
              language: assetLanguage(rel),
              loc: countBytesLoc(bytes),
              contentHash: sha256(bytes),
              facts: FileFacts.parse({
                imports: [],
                exports: [],
                exportAllFrom: [],
                flagUsages: [],
                constantConditions: [],
                isGenerated: false,
                loc: 0,
              }),
              resolutions: [],
            };
      assets.set(rel, asset);
    }
    return asset;
  };
  const inputs: FileInput[] = [];
  for (const [i, s] of sources.entries()) {
    const ctx = contextFor(s.reg);
    const pkg = packageOf.get(s.rel);
    const resolutions: { imp: RawImport; res: Resolution }[] = [];
    for (const imp of s.facts.imports) {
      let res = Resolution.parse(s.reg.adapter.resolveImport(imp, s.rel, ctx));
      if (
        (res.kind === "file" &&
          !analyzed.has(res.target) &&
          assetFor(res.target) === null) ||
        (res.kind === "package" && !members.has(res.target))
      ) {
        res = { kind: "unresolved", reason: "not-found" };
      }
      resolutions.push({ imp, res });
      opts.onResolution?.(s.rel, imp, res);
    }
    inputs.push({
      id: s.rel,
      language: s.reg.languageFor(s.rel),
      loc: s.facts.loc,
      contentHash: s.contentHash,
      facts: s.facts,
      resolutions,
      partial: s.partial,
      ...(pkg !== undefined ? { package: pkg } : {}),
    });
    progress("resolve", i + 1, sources.length);
  }
  for (const asset of assets.values()) if (asset) inputs.push(asset);
  const t4 = performance.now();

  // 5. Graph
  progress("graph", 0, 1);
  const built = Graph.parse(
    buildGraph(inputs, {
      packageHash: (hashes) => sha256(hashes.join("\n")),
    }),
  );
  const cycles = stronglyConnectedComponents(built, CERTAIN_EDGE_KINDS);
  const t5 = performance.now();

  // 7. Score (6. Enrich adds hint edges in M6): churn, coverage, risk.
  const churn =
    opts.history === false
      ? undefined
      : (opts.churnMemo ?? new ChurnMemo()).get(found.root, reader, opts.git);
  const scored = scoreGraph(
    built,
    churn,
    loadCoverage(found.root, reader, opts.coverageFile),
    members,
  );
  const graph = Graph.parse(scored.graph);
  progress("graph", 1, 1);
  const t6 = performance.now();

  if (cache) {
    manifest.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
    cache.putRepoIndex({
      root: found.root,
      lastCommit: readHeadCommit(reader, found.root),
      scanStartedNs: String(scanStartedNs),
      files: manifest,
    });
  }

  skipped.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const parseErrors = sources.filter((s) => s.partial).map((s) => s.rel);
  const meta = AnalysisMeta.parse({
    epochVersion: EPOCH_VERSION,
    schemaVersion: GRAPH_SCHEMA_VERSION,
    adapters: registrations.map(({ adapter: a }) => ({
      id: a.id,
      version: a.version,
      tier: a.tier,
    })),
    timingsMs: {
      discover: t1 - t0,
      changes: t2 - t1,
      parse: t3 - t2,
      resolve: t4 - t3,
      graph: t5 - t4,
      score: t6 - t5,
      total: t6 - t0,
    },
    counts: {
      filesAnalyzed: sources.length,
      nodes: graph.nodes.length,
      edges: graph.edges.length,
      externals: new Set(graph.nodes.flatMap((n) => n.externals)).size,
      unresolved: graph.unresolved.length,
      skipped: skipped.length,
      parseErrors: parseErrors.length,
      cacheHits,
      cacheMisses: sources.length - cacheHits,
      rehashed: scan.rehashed,
    },
    skipped,
    parseErrors,
    cycles,
    git: scored.git,
    coverage: scored.coverage,
    host: {
      platform: process.platform,
      arch: process.arch,
      node: process.versions.node,
    },
  });
  progress("done", 1, 1);
  return { graph, meta };
}
