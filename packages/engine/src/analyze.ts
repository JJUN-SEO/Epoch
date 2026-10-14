import { createHash } from "node:crypto";
import fs from "node:fs";
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
  type FileInput,
  type Progress,
  type RawImport,
  type RepoView,
  type ResolveContext,
  type SkipReason,
} from "@epoch-dev/core";
import { typescriptRegistration } from "@epoch-dev/adapter-typescript";
import { discover } from "./discover.js";
import { Parsers } from "./parse.js";
import { FsReader } from "./reader.js";

export interface AnalyzeOptions {
  readonly onProgress?: (p: Progress) => void;
  /** Adapters to run; defaults to every built-in adapter. */
  readonly registrations?: readonly AdapterRegistration<Tree>[];
  readonly maxFileBytes?: number;
}

export interface AnalyzeResult {
  readonly graph: Graph;
  readonly meta: AnalysisMeta;
}

export const DEFAULT_REGISTRATIONS: readonly AdapterRegistration<Tree>[] = [
  typescriptRegistration,
];

const EPOCH_VERSION = ((): string => {
  const manifest: unknown = JSON.parse(
    fs.readFileSync(new URL("../package.json", import.meta.url), "utf8"),
  );
  const version =
    typeof manifest === "object" && manifest !== null && "version" in manifest
      ? manifest.version
      : undefined;
  return typeof version === "string" ? version : "0.0.0";
})();

const sha256 = (bytes: Uint8Array): string =>
  createHash("sha256").update(bytes).digest("hex");

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
 * Runs the M1 pipeline on a project folder: Discover, Parse, Extract,
 * Resolve, Graph (CLAUDE.md "Pipeline", stages 1-5). Reads the project only
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

  // 2-3. Parse and Extract
  const sourceRels = found.files.filter((rel) => regFor(rel) !== undefined);
  const grammars = new Set<string>();
  for (const rel of sourceRels) {
    const g = regFor(rel)?.grammarFor(rel);
    if (g !== undefined) grammars.add(g);
  }
  const parsers = await Parsers.load(grammars);
  const sources: SourceFile[] = [];
  try {
    progress("parse", 0, sourceRels.length);
    for (const [i, rel] of sourceRels.entries()) {
      const reg = regFor(rel);
      const grammar = reg?.grammarFor(rel);
      const bytes = reader.readBytes(abs(rel));
      if (reg === undefined || grammar === undefined) continue;
      if (bytes === undefined) {
        skipped.push({ path: rel, reason: "unreadable" });
        continue;
      }
      const text = bytes.toString("utf8").replace(/^\uFEFF/, "");
      const tree = parsers.parse(grammar, text);
      const partial = tree.rootNode.hasError;
      let facts: FileFacts;
      try {
        facts = FileFacts.parse(
          reg.adapter.extract(
            { path: rel, text, tree },
            EMPTY_EXTRACTOR_CONFIG,
          ),
        );
      } finally {
        tree.delete();
      }
      sources.push({ rel, reg, contentHash: sha256(bytes), facts, partial });
      progress("parse", i + 1, sourceRels.length);
    }
  } finally {
    parsers.dispose();
  }
  const t2 = performance.now();

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
    const resolutions: { imp: RawImport; res: Resolution }[] = [];
    for (const imp of s.facts.imports) {
      let res = Resolution.parse(s.reg.adapter.resolveImport(imp, s.rel, ctx));
      if (
        res.kind === "file" &&
        !analyzed.has(res.target) &&
        assetFor(res.target) === null
      ) {
        res = { kind: "unresolved", reason: "not-found" };
      }
      resolutions.push({ imp, res });
    }
    inputs.push({
      id: s.rel,
      language: s.reg.languageFor(s.rel),
      loc: s.facts.loc,
      contentHash: s.contentHash,
      facts: s.facts,
      resolutions,
      partial: s.partial,
    });
    progress("resolve", i + 1, sources.length);
  }
  for (const asset of assets.values()) if (asset) inputs.push(asset);
  const t3 = performance.now();

  // 5. Graph
  progress("graph", 0, 1);
  const graph = Graph.parse(buildGraph(inputs));
  const cycles = stronglyConnectedComponents(graph, CERTAIN_EDGE_KINDS);
  progress("graph", 1, 1);
  const t4 = performance.now();

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
      parse: t2 - t1,
      resolve: t3 - t2,
      graph: t4 - t3,
      total: t4 - t0,
    },
    counts: {
      filesAnalyzed: sources.length,
      nodes: graph.nodes.length,
      edges: graph.edges.length,
      externals: new Set(graph.nodes.flatMap((n) => n.externals)).size,
      unresolved: graph.unresolved.length,
      skipped: skipped.length,
      parseErrors: parseErrors.length,
    },
    skipped,
    parseErrors,
    cycles,
    host: {
      platform: process.platform,
      arch: process.arch,
      node: process.versions.node,
    },
  });
  progress("done", 1, 1);
  return { graph, meta };
}
