import fs from "node:fs";
import {
  compareCodeUnits,
  withRiskTiers,
  type AnalysisMeta,
  type Graph,
  type GraphNode,
} from "@epoch-dev/core";
import { gitChurn, type Churn } from "./churn.js";
import {
  COVERAGE_GROUPS,
  MAX_COVERAGE_BYTES,
  detectFormat,
  inFolder,
  mapCoverage,
  parseClover,
  parseCobertura,
  parseGoProfile,
  parseIstanbulJson,
  parseLcov,
  rebaseGoPaths,
  type CoverageFormat,
  type FileCoverage,
  type GoModule,
} from "./coverage.js";
import { readHeadCommit, type GitRunner } from "./git.js";
import type { FsReader } from "./reader.js";

/*
 * The Score stage (CLAUDE.md "Pipeline", stage 7): git churn and coverage
 * into each node's metrics, then each node's dependents and risk tier
 * (ADR-015). Churn and coverage are read
 * here (git log, a report file); the scoring itself is core's pure
 * withRiskTiers().
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
  readonly report: ReadonlyMap<string, FileCoverage>;
  readonly sources: readonly string[];
  /** The project folder a found report sits in ("" for the root). */
  readonly folder?: string;
}

type CoverageMeta = AnalysisMeta["coverage"];
type ReportProblem = NonNullable<
  NonNullable<CoverageMeta["chosen"]>["problem"]
>;

/** The reports the Score stage maps onto the graph's files. */
export interface CoverageInput {
  /** Most specific first: a file takes its coverage from the first report that covers it. */
  readonly reports: readonly LoadedCoverage[];
  readonly chosen?: CoverageMeta["chosen"];
  /** Report paths looked at (repo-relative), for the watcher. */
  readonly paths: readonly string[];
}

const PARSERS: Readonly<
  Record<
    Exclude<CoverageFormat, "cobertura">,
    (text: string) => Map<string, FileCoverage>
  >
> = {
  lcov: parseLcov,
  "istanbul-json": parseIstanbulJson,
  clover: parseClover,
  go: parseGoProfile,
};

function parseReport(source: string, text: string): LoadedCoverage | undefined {
  const format = detectFormat(text);
  if (format === undefined) return undefined;
  if (format === "cobertura") {
    const { sources, files } = parseCobertura(text);
    return { source, format, report: files, sources };
  }
  return { source, format, report: PARSERS[format](text), sources: [] };
}

/** A repo-relative report, read through the root-confined reader. */
function readReport(
  root: string,
  reader: FsReader,
  rel: string,
): LoadedCoverage | ReportProblem {
  const st = reader.statFile(`${root}/${rel}`);
  if (!st) return "missing";
  if (st.size > MAX_COVERAGE_BYTES) return "too-large";
  const text = reader.readFile(`${root}/${rel}`);
  if (text === undefined) return "missing";
  return parseReport(rel, text) ?? "unrecognized";
}

const depth = (folder: string) =>
  folder === "" ? 0 : folder.split("/").length;

/**
 * The coverage reports to use (ADR-020): `explicit` (an absolute path the
 * user gave, CLI --coverage); else `chosen` (a repo-relative report chosen in
 * the app); else the first report of each conventional group in the root and
 * in every project folder, most specific folder first. Reports in the
 * project are read through the root-confined reader.
 */
export function loadCoverage(
  root: string,
  reader: FsReader,
  opts: {
    readonly explicit?: string;
    readonly chosen?: string;
    readonly folders?: readonly string[];
  } = {},
): CoverageInput {
  const { explicit, chosen } = opts;
  if (explicit !== undefined) {
    const size = fs.statSync(explicit).size;
    if (size > MAX_COVERAGE_BYTES) {
      throw new Error(
        `Coverage report too large (${String(size)} bytes): ${explicit}`,
      );
    }
    const loaded = parseReport(explicit, fs.readFileSync(explicit, "utf8"));
    if (!loaded) {
      throw new Error(
        `Not an lcov, Cobertura, Istanbul JSON, Clover or Go coverage report: ${explicit}`,
      );
    }
    return { reports: [loaded], paths: [] };
  }
  if (chosen !== undefined) {
    const read = readReport(root, reader, chosen);
    return typeof read === "string"
      ? {
          reports: [],
          chosen: { path: chosen, problem: read },
          paths: [chosen],
        }
      : { reports: [read], chosen: { path: chosen }, paths: [chosen] };
  }
  const folders = [...new Set(["", ...(opts.folders ?? [])])].sort(
    (a, b) => depth(b) - depth(a) || compareCodeUnits(a, b),
  );
  const reports: LoadedCoverage[] = [];
  const paths: string[] = [];
  for (const folder of folders) {
    for (const group of COVERAGE_GROUPS) {
      let found = false;
      for (const name of group) {
        const rel = folder === "" ? name : `${folder}/${name}`;
        paths.push(rel);
        if (found) continue;
        const read = readReport(root, reader, rel);
        if (typeof read !== "string") {
          reports.push({ ...read, folder });
          found = true;
        }
      }
    }
  }
  return { reports, paths };
}

/**
 * Maps each report onto the analyzed files. A file keeps the coverage of the
 * first report that covers it, so nested reports never add up.
 */
function mapReports(
  input: CoverageInput,
  fileIds: readonly string[],
  goModules: readonly GoModule[],
): { files: Map<string, FileCoverage>; meta: CoverageMeta } {
  const files = new Map<string, FileCoverage>();
  const reports = input.reports.map((c) => {
    let report: ReadonlyMap<string, FileCoverage> = c.report;
    let sources = c.sources;
    let outside = 0;
    if (c.format === "go") {
      ({ files: report, outside } = rebaseGoPaths(report, goModules));
    } else if (c.folder !== undefined) {
      ({ report, sources } = inFolder(report, sources, c.folder));
    }
    const mapped = mapCoverage(report, fileIds, sources);
    let supplied = 0;
    for (const [file, coverage] of mapped.files) {
      if (files.has(file)) continue;
      files.set(file, coverage);
      supplied++;
    }
    return {
      source: c.source,
      format: c.format,
      files: supplied,
      unmatched: mapped.unmatched + outside,
      ambiguous: mapped.ambiguous,
    };
  });
  return {
    files,
    meta: { reports, ...(input.chosen ? { chosen: input.chosen } : {}) },
  };
}

export interface ScoreResult {
  readonly graph: Graph;
  readonly git: AnalysisMeta["git"];
  readonly coverage: AnalysisMeta["coverage"];
}

/**
 * Sets churn90d, coverage, dependents and the risk tier on the graph's nodes. `members`
 * names the files of each package node (Go); a package's churn counts the
 * distinct commits that touched any member, its coverage sums theirs.
 * `goModules` maps Go profiles' import paths to folders.
 */
export function scoreGraph(
  graph: Graph,
  churn: Churn | undefined,
  coverage: CoverageInput | undefined,
  members: ReadonlyMap<string, readonly string[]> = new Map(),
  goModules: readonly GoModule[] = [],
): ScoreResult {
  const filesOf = (n: GraphNode) => members.get(n.id) ?? [n.id];
  const fileIds = graph.nodes.flatMap((n) => filesOf(n));
  const mapped = coverage
    ? mapReports(coverage, fileIds, goModules)
    : { files: new Map<string, FileCoverage>(), meta: { reports: [] } };
  const history = churn?.status.usable === true ? churn : undefined;

  const nodes = graph.nodes.map((n) => {
    const {
      churn90d: _c,
      coverage: _v,
      dependents: _d,
      risk: _r,
      ...metrics
    } = n.metrics;
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
      const c = mapped.files.get(f);
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
    graph: withRiskTiers({ ...graph, nodes }),
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
    coverage: mapped.meta,
  };
}
