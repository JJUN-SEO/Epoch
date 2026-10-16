import {
  HINT_DEFAULTS,
  cochangeCandidates,
  hintEdges,
  isHintEdge,
  mergeCandidates,
  sharedStringCandidates,
  type AnalysisMeta,
  type CandidatePair,
  type DerivedStore,
  type Graph,
  type GraphEdge,
  type RelationScorer,
} from "@epoch-dev/core";
import { HeuristicScorer } from "@epoch-dev/scorers";
import { gitCommitSets } from "./cochange.js";
import type { GitRunner } from "./git.js";
import type { FsReader } from "./reader.js";

/*
 * The Enrich stage (CLAUDE.md "Pipeline", stage 6, M6): hint edges from git
 * co-change and shared strings, scored by a RelationScorer (the heuristic by
 * default). Only generated candidates are scored, never all pairs. Hints are
 * recomputed every run, like the rest of the graph: co-change from the
 * commit sets (cached per HEAD), shared strings from the cached FileFacts.
 */

export interface HintOptions {
  /** Co-change cutoffs, or false to skip co-change. */
  readonly cochange?:
    | false
    | {
        readonly days?: number;
        readonly maxFiles?: number;
        readonly minSupport?: number;
      };
  /** Shared-string cutoffs, or false to skip shared strings. */
  readonly strings?: false | { readonly maxFiles?: number };
  readonly floor?: number;
  readonly perNode?: number;
  /**
   * Called with every merged candidate before scoring, and the file-to-node
   * map they use (benchmarks: bench:scorers labels them with later history).
   */
  readonly onCandidates?: (info: {
    readonly candidates: readonly CandidatePair[];
    readonly nodeOf: ReadonlyMap<string, string>;
  }) => void;
  /** The scorer whose edges go into the graph; the heuristic by default. */
  readonly scorer?: {
    readonly id: string;
    readonly scorer: RelationScorer;
    /** A model scorer: its edges are `semantic` hints with provenance `model`. */
    readonly byModel: boolean;
  };
}

export interface EnrichInput {
  /** The graph of fact edges. */
  readonly graph: Graph;
  /** The repository's top level. */
  readonly root: string;
  readonly reader: FsReader;
  /** Repo-relative file -> its node (a Go package member -> the package). */
  readonly nodeOf: ReadonlyMap<string, string>;
  /** Each analyzed source file's key-like strings (FileFacts.strings). */
  readonly strings: readonly {
    readonly path: string;
    readonly strings: readonly string[];
  }[];
  /** False when the run must not read git history (co-change is then off). */
  readonly history: boolean;
  readonly run?: GitRunner;
  readonly store?: DerivedStore;
}

export interface EnrichResult {
  /** Hint edges, in canonical order. */
  readonly edges: GraphEdge[];
  readonly meta: AnalysisMeta["hints"];
}

/** The hint edges for a graph, and what produced them. */
export async function enrich(
  input: EnrichInput,
  opts: HintOptions = {},
): Promise<EnrichResult> {
  const candidates: CandidatePair[][] = [];

  let cochange: AnalysisMeta["hints"]["cochange"] = {
    status: "off",
    commits: 0,
    pairs: 0,
  };
  if (opts.cochange !== false && input.history) {
    const cfg = { ...HINT_DEFAULTS.cochange, ...opts.cochange };
    const sets = gitCommitSets(input.root, input.reader, {
      days: cfg.days,
      ...(input.run ? { run: input.run } : {}),
      ...(input.store ? { store: input.store } : {}),
    });
    // The size cutoff counts every file a commit touched, so a bulk change
    // stays out even when few of its files are analyzed.
    const commits = sets.commits
      .filter((files) => files.length <= cfg.maxFiles)
      .map((files) =>
        files.flatMap((f) => {
          const node = input.nodeOf.get(f);
          return node === undefined ? [] : [node];
        }),
      );
    const pairs = cochangeCandidates(commits, {
      maxFiles: Number.POSITIVE_INFINITY,
      minSupport: cfg.minSupport,
    });
    candidates.push(pairs);
    cochange = {
      status: sets.status,
      commits: commits.length,
      pairs: pairs.length,
    };
  }

  let stringPairs = 0;
  if (opts.strings !== false) {
    const cfg = { ...HINT_DEFAULTS.strings, ...opts.strings };
    const pairs = sharedStringCandidates(
      input.strings.map((f) => ({
        id: input.nodeOf.get(f.path) ?? f.path,
        strings: f.strings,
      })),
      { maxFiles: cfg.maxFiles },
    );
    candidates.push(pairs);
    stringPairs = pairs.length;
  }

  const merged = mergeCandidates(...candidates);
  opts.onCandidates?.({ candidates: merged, nodeOf: input.nodeOf });
  const scorer = opts.scorer ?? {
    id: "heuristic",
    scorer: new HeuristicScorer(),
    byModel: false,
  };
  const scored =
    merged.length === 0 ? [] : await scorer.scorer.scoreRelations(merged);
  const facts = new Set(
    input.graph.edges
      .filter((e) => !isHintEdge(e))
      .map((e) => `${e.source}\u0000${e.target}`),
  );
  const edges = hintEdges(merged, scored, {
    floor: opts.floor ?? HINT_DEFAULTS.floor,
    perNode: opts.perNode ?? HINT_DEFAULTS.perNode,
    byModel: scorer.byModel,
    facts,
  });
  return {
    edges,
    meta: {
      cochange,
      strings: { pairs: stringPairs },
      embeddings: { status: "off", pairs: 0 },
      scorer: scorer.id,
      edges: edges.length,
    },
  };
}
