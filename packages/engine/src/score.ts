import fs from "node:fs";
import {
  withRiskScores,
  type AnalysisMeta,
  type Graph,
  type GraphNode,
} from "@epoch-dev/core";
import { gitChurn, type Churn } from "./churn.js";
import {
  COVERAGE_CANDIDATES,
  MAX_COVERAGE_BYTES,
  detectFormat,
  mapCoverage,
  parseCobertura,
  parseLcov,
  type CoverageFormat,
  type MappedCoverage,
} from "./coverage.js";
import { readHeadCommit, type GitRunner } from "./git.js";
import type { FsReader } from "./reader.js";

/*
 * The Score stage (CLAUDE.md "Pipeline", stage 7): git churn and coverage
 * into each node's metrics, then the risk score. Churn and coverage are read
 * here (git log, a report file); the scoring itself is core's pure
 * withRiskScores().
 */

/** Churn per repository and HEAD, so watcher re-runs do not re-read history. */
export class ChurnMemo {
  private readonly entries = new Map<string, Churn>();

  get(root: string, reader: FsReader, run?: GitRunner): Churn {
    const key = `${root}\u0000${readHeadCommit(reader, root) ?? ""}`;
    let churn = this.entries.get(key);
    if (!churn) {
      churn = gitChurn(root, reader, run);
      this.entries.clear(); // one HEAD at a time is enough
      this.entries.set(key, churn);
    }
    return churn;
  }
}

export interface LoadedCoverage {
  readonly source: string;
  readonly format: CoverageFormat;
  readonly report: ReadonlyMap<string, { lines: number; covered: number }>;
  readonly sources: readonly string[];
}

function parseReport(source: string, text: string): LoadedCoverage | undefined {
  const format = detectFormat(text);
  if (format === "lcov")
    return { source, format, report: parseLcov(text), sources: [] };
  if (format === "cobertura") {
    const { sources, files } = parseCobertura(text);
    return { source, format, report: files, sources };
  }
  return undefined;
}

/**
 * The coverage report to use: `explicit` (an absolute path the user gave),
 * else the first conventional report inside the project, read through the
 * root-confined reader. Oversized or unrecognized files are ignored.
 */
export function loadCoverage(
  root: string,
  reader: FsReader,
  explicit?: string,
): LoadedCoverage | undefined {
  if (explicit !== undefined) {
    const size = fs.statSync(explicit).size;
    if (size > MAX_COVERAGE_BYTES) {
      throw new Error(
        `Coverage report too large (${String(size)} bytes): ${explicit}`,
      );
    }
    const loaded = parseReport(explicit, fs.readFileSync(explicit, "utf8"));
    if (!loaded)
      throw new Error(`Not an lcov or Cobertura report: ${explicit}`);
    return loaded;
  }
  for (const rel of COVERAGE_CANDIDATES) {
    const st = reader.statFile(`${root}/${rel}`);
    if (!st || st.size > MAX_COVERAGE_BYTES) continue;
    const text = reader.readFile(`${root}/${rel}`);
    const loaded = text === undefined ? undefined : parseReport(rel, text);
    if (loaded) return loaded;
  }
  return undefined;
}

export interface ScoreResult {
  readonly graph: Graph;
  readonly git: AnalysisMeta["git"];
  readonly coverage: AnalysisMeta["coverage"];
}

/**
 * Sets churn90d, coverage and riskScore on the graph's nodes. `members`
 * names the files of each package node (Go); a package's churn counts the
 * distinct commits that touched any member, its coverage sums theirs.
 */
export function scoreGraph(
  graph: Graph,
  churn: Churn | undefined,
  coverage: LoadedCoverage | undefined,
  members: ReadonlyMap<string, readonly string[]> = new Map(),
): ScoreResult {
  const filesOf = (n: GraphNode) => members.get(n.id) ?? [n.id];
  const fileIds = graph.nodes.flatMap((n) => filesOf(n));
  const mapped: MappedCoverage | undefined = coverage
    ? mapCoverage(coverage.report, fileIds, coverage.sources)
    : undefined;
  const history = churn?.status.usable === true ? churn : undefined;

  const nodes = graph.nodes.map((n) => {
    const { churn90d: _c, coverage: _v, riskScore: _r, ...metrics } = n.metrics;
    const files = filesOf(n);
    let churn90d: number | undefined;
    if (history) {
      const commits = new Set<string>();
      for (const f of files)
        for (const c of history.commits.get(f) ?? []) commits.add(c);
      churn90d = commits.size;
    }
    let lines = 0;
    let covered = 0;
    for (const f of files) {
      const c = mapped?.files.get(f);
      if (c) {
        lines += c.lines;
        covered += c.covered;
      }
    }
    return {
      ...n,
      metrics: {
        ...metrics,
        ...(churn90d === undefined ? {} : { churn90d }),
        ...(lines > 0 ? { coverage: covered / lines } : {}),
      },
    };
  });

  const status = churn?.status;
  return {
    graph: withRiskScores({ ...graph, nodes }),
    git:
      status === undefined
        ? { status: "off" }
        : status.usable
          ? {
              status: "usable",
              shallow: status.shallow,
              head: status.head,
              churnSince: status.since,
              churnUntil: status.until,
            }
          : { status: status.reason },
    coverage:
      coverage && mapped
        ? {
            source: coverage.source,
            format: coverage.format,
            files: mapped.files.size,
            unmatched: mapped.unmatched,
            ambiguous: mapped.ambiguous,
          }
        : null,
  };
}
