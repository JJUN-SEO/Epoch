import { z } from "zod";
import { canonicalJson } from "./cache/canonical-json.js";
import { compareCodeUnits } from "./canonical.js";
import { nodeFolder } from "./graph/folders.js";
import { stronglyConnectedComponents } from "./graph/scc.js";
import { CERTAIN_EDGE_KINDS } from "./policy.js";
import type { Graph } from "./schemas/index.js";

/*
 * Prose summaries (M7; CLAUDE.md "Local cache": hierarchical, bottom-up,
 * lazy, early cutoff). Pure: the engine hashes, stores and calls models.
 *
 * A summary is cached under a key made from what was sent: the prompt
 * version, provider, model, subject, and the hash of the content sent (a
 * file's source; a folder's child summaries). An unchanged file finds its
 * summary again, after switching branches and back too. Each summary also
 * records the dependency summaries it was given; when those changed, it is
 * still shown, marked stale, and regenerated only when the user asks.
 */

/** Bump when the prompt changes: every summary is then made again. */
export const SUMMARY_PROMPT_VERSION = 1;
/** Summaries are short; anything longer is cut by the engine and refused here. */
export const MAX_SUMMARY_CHARS = 2000;

const Hash = z.string().regex(/^[0-9a-f]{64}$/, "not a sha256");

/** A summary given as input: its subject and the sha256 of its text. */
export const SummaryRef = z.strictObject({
  subject: z.string().min(1).max(4096),
  hash: Hash,
});
export type SummaryRef = z.infer<typeof SummaryRef>;

/**
 * A stored summary: model text and how it was made. Never source code
 * (the engine's sanitizer drops anything that looks like a source line).
 */
export const StoredSummary = z.strictObject({
  /** A node id, or "dir:<path>" for a folder ("dir:" is the project root). */
  subject: z.string().min(1).max(4096),
  provider: z.enum(["anthropic", "local"]),
  model: z.string().min(1).max(200),
  promptVersion: z.number().int().positive(),
  /** sha256 of the content sent. */
  contentHash: z.string().min(1).max(128),
  text: z.string().min(1).max(MAX_SUMMARY_CHARS),
  /** Dependency (file) or child (folder) summaries in the prompt. */
  used: z.array(SummaryRef).max(256),
  createdAt: z.iso.datetime(),
  /** As the provider reported it; costUsd at the user's prices (0 on this machine). */
  usage: z.strictObject({
    inputTokens: z.number().int().nonnegative(),
    outputTokens: z.number().int().nonnegative(),
    costUsd: z.number().nonnegative(),
  }),
});
export type StoredSummary = z.infer<typeof StoredSummary>;

export interface SummaryKeyInputs {
  readonly promptVersion: number;
  readonly provider: string;
  readonly model: string;
  readonly subject: string;
  readonly contentHash: string;
}

/** The text a summary's cache key is the sha256 of. */
export const summaryKeyText = (i: SummaryKeyInputs): string =>
  canonicalJson([
    "epoch-summary",
    i.promptVersion,
    i.provider,
    i.model,
    i.subject,
    i.contentHash,
  ]);

export type SummaryStatus =
  | { readonly state: "missing" }
  | { readonly state: "fresh"; readonly summary: StoredSummary }
  | {
      readonly state: "stale";
      /** file: the content changed (hard); dependencies: only summaries it used did (soft). */
      readonly why: "file" | "dependencies";
      /** What to show meanwhile. */
      readonly previous: StoredSummary;
    };

const refKey = (r: SummaryRef) => `${r.subject}\u0000${r.hash}`;

function sameRefs(a: readonly SummaryRef[], b: readonly SummaryRef[]): boolean {
  if (a.length !== b.length) return false;
  const set = new Set(a.map(refKey));
  return b.every((r) => set.has(refKey(r)));
}

/**
 * Fresh when a summary exists for this content and was given the same
 * summaries the prompt would get now; else the latest summary of the
 * subject, marked stale, or nothing.
 */
export function summaryStatus(args: {
  /** The summary stored under this content's key. */
  readonly hit?: StoredSummary | undefined;
  /** The subject's most recent summary, under any key. */
  readonly latest?: StoredSummary | undefined;
  /** The summaries the prompt would be given now. */
  readonly currentDeps: readonly SummaryRef[];
}): SummaryStatus {
  if (args.hit)
    return sameRefs(args.hit.used, args.currentDeps)
      ? { state: "fresh", summary: args.hit }
      : { state: "stale", why: "dependencies", previous: args.hit };
  if (args.latest)
    return { state: "stale", why: "file", previous: args.latest };
  return { state: "missing" };
}

/**
 * The nodes a node's summary may draw on: its direct dependencies over the
 * certain edge set (never hints), sorted.
 */
export function summaryDependencies(graph: Graph, subject: string): string[] {
  const out = new Set<string>();
  for (const e of graph.edges) {
    if (
      e.source === subject &&
      e.target !== subject &&
      CERTAIN_EDGE_KINDS.has(e.kind)
    )
      out.add(e.target);
  }
  return [...out].sort(compareCodeUnits);
}

/**
 * Bottom-up order for summarizing `subjects`: in waves, each holding what
 * depends only on earlier waves (over certain edges between the subjects);
 * a cycle is one group, as its members cannot wait for each other. Groups
 * within a wave are sorted by first member.
 */
export function summaryOrder(
  graph: Graph,
  subjects: readonly string[],
): string[][] {
  const ids = new Set(graph.nodes.map((n) => n.id));
  const wanted = new Set(subjects.filter((s) => ids.has(s)));
  const sub: Graph = {
    ...graph,
    nodes: graph.nodes.filter((n) => wanted.has(n.id)),
    edges: graph.edges.filter(
      (e) =>
        CERTAIN_EDGE_KINDS.has(e.kind) &&
        wanted.has(e.source) &&
        wanted.has(e.target),
    ),
  };
  const groupOf = new Map<string, string[]>();
  for (const cycle of stronglyConnectedComponents(sub, CERTAIN_EDGE_KINDS))
    for (const id of cycle) groupOf.set(id, cycle);
  const groups: string[][] = [];
  for (const id of [...wanted].sort(compareCodeUnits)) {
    const g = groupOf.get(id) ?? [id];
    if (g[0] === id) groups.push(g);
  }
  const leader = (id: string) => (groupOf.get(id) ?? [id])[0] ?? id;
  const needs = new Map<string, Set<string>>();
  for (const g of groups) needs.set(g[0] ?? "", new Set());
  for (const e of sub.edges) {
    const [from, to] = [leader(e.source), leader(e.target)];
    if (from !== to) needs.get(from)?.add(to);
  }
  const done = new Set<string>();
  const out: string[][] = [];
  let pending = groups;
  while (pending.length > 0) {
    const wave = pending.filter((g) =>
      [...(needs.get(g[0] ?? "") ?? [])].every((d) => done.has(d)),
    );
    for (const g of wave) {
      out.push(g);
      done.add(g[0] ?? "");
    }
    pending = pending.filter((g) => !done.has(g[0] ?? ""));
  }
  return out;
}

const DIR = "dir:";
const inFolder = (folder: string, dir: string) =>
  dir === "" || folder === dir || folder.startsWith(`${dir}/`);
const depth = (p: string) => (p === "" ? 0 : p.split("/").length);

/**
 * A folder summary job (always confirmed by the user): every node under
 * `dir` bottom-up, then each folder from the deepest up, `dir` itself last,
 * so each folder's summary is made from its children's. Empty when nothing
 * is under `dir`.
 */
export function folderJob(graph: Graph, dir: string): string[] {
  const files: string[] = [];
  const folders = new Set<string>();
  for (const n of graph.nodes) {
    const folder = nodeFolder(n.id, graph);
    if (!inFolder(folder, dir)) continue;
    files.push(n.id);
    for (
      let f = folder;
      ;
      f = f.includes("/") ? f.slice(0, f.lastIndexOf("/")) : ""
    ) {
      folders.add(f);
      if (f === dir || f === "") break;
    }
  }
  if (files.length === 0) return [];
  const dirs = [...folders]
    .filter((f) => inFolder(f, dir))
    .sort((a, b) => depth(b) - depth(a) || compareCodeUnits(a, b));
  return [
    ...summaryOrder(graph, files).flat(),
    ...dirs.map((d) => `${DIR}${d}`),
  ];
}
