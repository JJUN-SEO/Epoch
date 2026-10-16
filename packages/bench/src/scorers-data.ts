import childProcess from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  HINT_DEFAULTS,
  isHintEdge,
  type CandidatePair,
  type ScoredRelation,
} from "@epoch-dev/core";
import { FsReader, analyze, toPosix, type ParsePool } from "@epoch-dev/engine";
import {
  ModelScorer,
  type ModelRunReport,
  type ResolvedModel,
} from "@epoch-dev/scorers";
import { forwardCommits } from "./scorer-eval.js";

/*
 * The data half of bench:scorers (ADR-008): what the Enrich stage proposes
 * at a past commit, and what changed afterwards. A snapshot is analyzed in
 * a shared clone checked out at that commit, so its co-change features see
 * only history up to it.
 */

const git = (cwd: string, ...args: string[]): string =>
  childProcess.execFileSync(
    "git",
    ["-c", "core.fsmonitor=false", "--no-pager", ...args],
    { cwd, encoding: "utf8", maxBuffer: 1024 * 1024 * 1024 },
  );

const iso = (unixSeconds: number) => new Date(unixSeconds * 1000).toISOString();

export const headTime = (dir: string): number =>
  Number(git(dir, "log", "-1", "--format=%ct", "HEAD").trim());

export interface Snapshot {
  /** The mainline commit at or before the requested time. */
  readonly commit: string;
  /** Its committer date, Unix seconds. */
  readonly time: number;
  /** Every candidate the Enrich stage proposed, before scoring. */
  readonly candidates: readonly CandidatePair[];
  /** "source\0target" of the snapshot's fact edges. */
  readonly facts: ReadonlySet<string>;
  readonly nodeOf: ReadonlyMap<string, string>;
  readonly enrichMs: number;
  readonly analyzeMs: number;
  /** A model scorer's scores for this snapshot's candidates, when one was asked for. */
  readonly model?: {
    readonly scores: readonly ScoredRelation[];
    readonly report: ModelRunReport;
  };
}

/** The Enrich stage's candidates at the last mainline commit at or before `at`. */
export async function snapshotAt(
  dir: string,
  at: number,
  opts: {
    readonly pool?: ParsePool;
    /** Also score the candidates with this model (it reads the snapshot's files). */
    readonly model?: ResolvedModel;
    readonly onPlan?: (text: string) => void;
  } = {},
): Promise<Snapshot | undefined> {
  const commit = git(
    dir,
    "rev-list",
    "-1",
    "--first-parent",
    `--before=${iso(at)}`,
    "HEAD",
  ).trim();
  if (commit === "") return undefined;
  const time = Number(git(dir, "log", "-1", "--format=%ct", commit).trim());
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "epoch-bench-scorers-"));
  try {
    git(os.tmpdir(), "clone", "-q", "--shared", "--no-checkout", dir, tmp);
    git(tmp, "checkout", "-q", commit);
    let captured:
      | {
          candidates: readonly CandidatePair[];
          nodeOf: ReadonlyMap<string, string>;
        }
      | undefined;
    let model: ModelScorer | undefined;
    let scores: ScoredRelation[] = [];
    if (opts.model) {
      const root = toPosix(fs.realpathSync.native(tmp));
      const reader = new FsReader(root);
      model = new ModelScorer({
        backend: opts.model.backend,
        readText: (rel) => reader.readFile(`${root}/${rel}`),
        consent: opts.model.consent,
        maxPairs: opts.model.maxPairs,
        ...(opts.model.spend ? { spend: opts.model.spend } : {}),
        ...(opts.onPlan ? { onPlan: opts.onPlan } : {}),
      });
    }
    const t = performance.now();
    const { graph, meta } = await analyze(tmp, {
      ...(opts.pool ? { pool: opts.pool } : {}),
      hints: {
        onCandidates: (info) => {
          captured = info;
        },
        ...(model
          ? {
              scorer: {
                id: model.id,
                byModel: true,
                prepare: (context) => {
                  model.prepare(context);
                },
                scorer: {
                  scoreRelations: async (candidates) => {
                    scores = await model.scoreRelations(candidates);
                    return scores;
                  },
                  classifyFiles: () => Promise.resolve([]),
                },
              },
            }
          : {}),
      },
    });
    const analyzeMs = performance.now() - t;
    return {
      commit,
      time,
      candidates: captured?.candidates ?? [],
      facts: new Set(
        graph.edges
          .filter((e) => !isHintEdge(e))
          .map((e) => `${e.source}\u0000${e.target}`),
      ),
      nodeOf: captured?.nodeOf ?? new Map(),
      enrichMs: meta.timingsMs.enrich,
      analyzeMs,
      ...(model ? { model: { scores, report: model.report() } } : {}),
    };
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

/**
 * The non-merge commits after `from` up to `until` (Unix seconds), as the
 * snapshot's node ids: files named as they were at the snapshot (renames
 * followed forward), files the snapshot did not have dropped, and commits
 * touching more than `maxFiles` files skipped, as the Enrich stage does.
 */
export function laterCommits(
  dir: string,
  from: number,
  until: number,
  nodeOf: ReadonlyMap<string, string>,
  maxFiles: number = HINT_DEFAULTS.cochange.maxFiles,
): string[][] {
  const out = git(
    dir,
    "log",
    "--reverse",
    "--no-merges",
    "--no-show-signature",
    "-z",
    "--name-status",
    "-M",
    "--no-ext-diff",
    "--no-textconv",
    "--format=%x01%H",
    `--since=${iso(from + 1)}`,
    `--until=${iso(until)}`,
    "HEAD",
    "--",
  );
  return forwardCommits(out)
    .filter((files) => files.length <= maxFiles)
    .map((files) => [
      ...new Set(
        files.flatMap((f) => {
          const node = nodeOf.get(f);
          return node === undefined ? [] : [node];
        }),
      ),
    ])
    .filter((nodes) => nodes.length > 0);
}
