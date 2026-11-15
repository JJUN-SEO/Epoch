import {
  CERTAIN_EDGE_KINDS,
  HINT_DEFAULTS,
  LANGUAGE_TIERS,
  RISK_DEFAULTS,
  RISK_TIERS,
  assessRisk,
  atLeast,
  changeImpact,
  compareByRisk,
  compareCodeUnits,
  dependencyPath,
  filterFindings,
  isHintEdge,
  mostDependedOn,
  type AnalysisMeta,
  type BlastRadiusOptions,
  type ChangeImpactResult,
  type Confidence,
  type DependencyPath,
  type EdgeKind,
  type Finding,
  type FindingKind,
  type Graph,
  type GraphNode,
  type RiskAssessment,
  type RiskTier,
  type UnresolvedImport,
  type UnresolvedReason,
} from "@epoch-dev/core";

/*
 * What `epoch impact`, `path` and `explain` and the agent server answer
 * (ADR-021): reports built from one analysis by pure functions, so the
 * command line and an agent get the same facts. Graph facts only: no file
 * contents, and repository strings stay in data fields.
 */

/** One analysis, as the query commands and the agent server read it. */
export interface Snapshot {
  readonly graph: Graph;
  readonly meta: AnalysisMeta;
  /** Package node id to its member files (Go, ADR-013). */
  readonly packages: ReadonlyMap<string, readonly string[]>;
  /** Ids of findings dismissed in the app. */
  readonly dismissed: ReadonlySet<string>;
}

const traversal = (likely: boolean): BlastRadiusOptions =>
  likely
    ? {
        mode: "likely",
        includeTypeOnly: true,
        hintThreshold: HINT_DEFAULTS.threshold,
      }
    : { mode: "certain", includeTypeOnly: true };

const memberIndex = (s: Snapshot): Map<string, string> => {
  const of = new Map<string, string>();
  for (const [pkg, members] of s.packages) {
    for (const m of members) of.set(m, pkg);
  }
  return of;
};

/** Findings not dismissed in the app. */
const openFindings = (s: Snapshot): Finding[] =>
  filterFindings(s.graph.findings, { includeDismissed: false }, s.dismissed);

const normalize = (name: string): string =>
  name.replaceAll("\\", "/").replace(/^\.\//, "").replace(/\/+$/, "");

export type Resolved =
  | { readonly id: string }
  | { readonly error: string; readonly candidates: readonly string[] };

/**
 * The node a name refers to: a node id, a package's member file, or the one
 * node (or member) whose path ends with it. A name that fits several is
 * refused with the candidates, never guessed.
 */
export function resolveNode(s: Snapshot, name: string): Resolved {
  const wanted = normalize(name);
  const ids = new Set(s.graph.nodes.map((n) => n.id));
  if (ids.has(wanted)) return { id: wanted };
  const members = memberIndex(s);
  const pkg = members.get(wanted);
  if (pkg !== undefined) return { id: pkg };
  if (wanted === "") return { error: "No file was named.", candidates: [] };
  const hits = new Set<string>();
  for (const id of ids) if (id.endsWith(`/${wanted}`)) hits.add(id);
  for (const [file, owner] of members) {
    if (file.endsWith(`/${wanted}`)) hits.add(owner);
  }
  const candidates = [...hits].sort(compareCodeUnits);
  const [only] = candidates;
  if (candidates.length === 1 && only !== undefined) return { id: only };
  return candidates.length === 0
    ? { error: `No analyzed file matches ${wanted}.`, candidates: [] }
    : {
        error: `${wanted} matches ${String(candidates.length)} files; name one of them.`,
        candidates: candidates.slice(0, 10),
      };
}

/** Node ids whose path contains `query`, the closest matches first. */
export function findNodes(
  s: Snapshot,
  query: string,
  limit: number,
): { readonly matches: readonly string[]; readonly total: number } {
  const q = normalize(query).toLowerCase();
  if (q === "") return { matches: [], total: 0 };
  const rank = (path: string): number => {
    const p = path.toLowerCase();
    if (p === q) return 0;
    if (p.slice(p.lastIndexOf("/") + 1) === q) return 1;
    if (p.endsWith(`/${q}`)) return 2;
    return p.includes(q) ? 3 : -1;
  };
  const best = new Map<string, number>();
  const offer = (id: string, r: number) => {
    if (r >= 0 && r < (best.get(id) ?? Number.POSITIVE_INFINITY)) {
      best.set(id, r);
    }
  };
  for (const n of s.graph.nodes) offer(n.id, rank(n.id));
  for (const [file, owner] of memberIndex(s)) offer(owner, rank(file));
  const matches = [...best]
    .sort(([a, ra], [b, rb]) => ra - rb || compareCodeUnits(a, b))
    .map(([id]) => id);
  return { matches: matches.slice(0, limit), total: matches.length };
}

export interface RiskReport {
  readonly tier: RiskTier;
  readonly archetype: string;
  readonly exposure: RiskAssessment["exposure"];
  readonly change: RiskAssessment["change"];
  readonly fragility: RiskAssessment["fragility"];
}

/** A node's tier with the side of each threshold its facts fell on. */
function riskOf(n: GraphNode): RiskReport | undefined {
  const { risk, dependents, churn90d, coverage } = n.metrics;
  if (!risk || dependents === undefined || churn90d === undefined) {
    return undefined;
  }
  const a = assessRisk(
    {
      dependents,
      churn90d,
      loc: n.loc,
      ...(coverage === undefined ? {} : { coverage }),
    },
    RISK_DEFAULTS,
  );
  return {
    tier: risk.tier,
    archetype: risk.archetype,
    exposure: a.exposure,
    change: a.change,
    fragility: a.fragility,
  };
}

export interface Neighbor {
  readonly id: string;
  readonly kind: EdgeKind;
  readonly evidence: readonly string[];
}

export interface LikelyRelation extends Neighbor {
  /** `out`: this node likely depends on `id`; `in`: the reverse. */
  readonly direction: "out" | "in";
  readonly confidence: number;
}

export interface ExplainReport {
  readonly id: string;
  readonly kind: GraphNode["kind"];
  readonly language: string;
  /** A: precise resolution, measured; B: partial. Absent for other files. */
  readonly languageTier?: "A" | "B";
  readonly lines: number;
  /** Package nodes only: the files it stands for. */
  readonly members?: readonly string[];
  readonly entryPoint?: readonly string[];
  readonly dependents?: number;
  readonly commits90d?: number;
  /** Share of lines tests run, 0 to 1, when a coverage report covers it. */
  readonly coverage?: number;
  readonly risk?: RiskReport;
  /** What it imports directly (fact edges). */
  readonly imports: readonly Neighbor[];
  /** What imports it directly (fact edges). */
  readonly importedBy: readonly Neighbor[];
  /** Inferred relations at or above the default threshold: hints, never facts. */
  readonly likely: readonly LikelyRelation[];
  /** Third-party packages it imports. */
  readonly externals: readonly string[];
  readonly unresolved: readonly UnresolvedImport[];
  /** Open candidates located in it. */
  readonly findings: readonly Finding[];
}

const byNeighbor = (a: Neighbor, b: Neighbor) =>
  compareCodeUnits(a.id, b.id) || compareCodeUnits(a.kind, b.kind);

/** Everything Epoch knows about one node. */
export function explain(s: Snapshot, id: string): ExplainReport {
  const node = s.graph.nodes.find((n) => n.id === id);
  if (!node) throw new Error(`No node ${id} in the graph.`);
  const members = s.packages.get(id);
  const files = new Set([id, ...(members ?? [])]);
  const imports: Neighbor[] = [];
  const importedBy: Neighbor[] = [];
  const likely: LikelyRelation[] = [];
  for (const e of s.graph.edges) {
    if (e.source === e.target || (e.source !== id && e.target !== id)) continue;
    const out = e.source === id;
    const other = { id: out ? e.target : e.source, kind: e.kind };
    if (isHintEdge(e)) {
      if (e.confidence >= HINT_DEFAULTS.threshold) {
        likely.push({
          ...other,
          evidence: e.evidence,
          direction: out ? "out" : "in",
          confidence: e.confidence,
        });
      }
    } else if (CERTAIN_EDGE_KINDS.has(e.kind)) {
      (out ? imports : importedBy).push({ ...other, evidence: e.evidence });
    }
  }
  const roots = s.graph.roots
    .filter((r) => files.has(r.file))
    .map((r) => `${r.reason}: ${r.source}`);
  const tier = LANGUAGE_TIERS[node.language];
  const risk = riskOf(node);
  const { dependents, churn90d, coverage } = node.metrics;
  return {
    id,
    kind: node.kind,
    language: node.language,
    ...(tier === undefined ? {} : { languageTier: tier }),
    lines: node.loc,
    ...(members ? { members } : {}),
    ...(roots.length > 0
      ? { entryPoint: [...new Set(roots)].sort(compareCodeUnits) }
      : {}),
    ...(dependents === undefined ? {} : { dependents }),
    ...(churn90d === undefined ? {} : { commits90d: churn90d }),
    ...(coverage === undefined ? {} : { coverage }),
    ...(risk ? { risk } : {}),
    imports: imports.sort(byNeighbor),
    importedBy: importedBy.sort(byNeighbor),
    likely: likely.sort(
      (a, b) => b.confidence - a.confidence || byNeighbor(a, b),
    ),
    externals: node.externals,
    unresolved: s.graph.unresolved.filter((u) => files.has(u.from)),
    findings: openFindings(s).filter((f) =>
      f.locations.some((l) => files.has(l.file)),
    ),
  };
}

export interface PathReport {
  readonly from: string;
  readonly to: string;
  /** How `from` depends on `to`; null when it does not. */
  readonly path: DependencyPath | null;
  /** When `from` does not depend on `to`: how `to` depends on `from`, if it does. */
  readonly reverse: DependencyPath | null;
}

/** How two nodes are connected, in either direction. */
export function pathBetween(
  s: Snapshot,
  from: string,
  to: string,
  likely: boolean,
): PathReport {
  const opts = traversal(likely);
  const path = dependencyPath(s.graph, from, to, opts);
  return {
    from,
    to,
    path,
    reverse: path ? null : dependencyPath(s.graph, to, from, opts),
  };
}

export interface ImpactReport extends ChangeImpactResult {
  /** Whether hint edges were followed (likely mode). */
  readonly likely: boolean;
  /** The open candidates located in the changed files, most confident first. */
  readonly candidates: readonly Finding[];
}

/** What changing `paths` (repository-relative) touches. */
export function impact(
  s: Snapshot,
  paths: readonly string[],
  likely: boolean,
): ImpactReport {
  const members = memberIndex(s);
  const open = openFindings(s);
  const result = changeImpact(
    { ...s.graph, findings: open },
    paths.map(normalize),
    { ...traversal(likely), nodeOf: (p) => members.get(p) },
  );
  const ids = new Set(result.changed.flatMap((c) => c.findings));
  return { ...result, likely, candidates: open.filter((f) => ids.has(f.id)) };
}

/** Whether a change reaches `failOn`: a changed node at or above that tier. */
export const impactFails = (r: ImpactReport, failOn: RiskTier): boolean =>
  r.highestTier !== undefined &&
  RISK_TIERS.indexOf(r.highestTier) <= RISK_TIERS.indexOf(failOn);

export interface OverviewReport {
  readonly epochVersion: string;
  readonly files: number;
  readonly nodes: number;
  readonly factEdges: number;
  readonly likelyRelations: number;
  readonly languages: readonly {
    readonly language: string;
    readonly nodes: number;
    readonly tier?: "A" | "B";
  }[];
  readonly unresolved: Readonly<Partial<Record<UnresolvedReason, number>>>;
  readonly cycles: number;
  /** Git history behind churn and risk tiers: usable, or why not. */
  readonly git: AnalysisMeta["git"]["status"];
  readonly coverageReports: readonly string[];
  /** Nodes per risk tier; absent without git history. */
  readonly riskTiers?: Readonly<Record<RiskTier, number>>;
  /** Open candidates by confidence. Candidates, never verdicts. */
  readonly candidates: Readonly<Record<Confidence, number>>;
  readonly mostDependedOn: readonly {
    readonly id: string;
    readonly dependents: number;
  }[];
  readonly riskiest: readonly {
    readonly id: string;
    readonly tier: RiskTier;
  }[];
}

const TOP = 10;

/** The project at a glance. */
export function overview(s: Snapshot): OverviewReport {
  const { graph, meta } = s;
  const languages = new Map<string, number>();
  const tiers = new Map<RiskTier, number>();
  for (const n of graph.nodes) {
    languages.set(n.language, (languages.get(n.language) ?? 0) + 1);
    const tier = n.metrics.risk?.tier;
    if (tier !== undefined) tiers.set(tier, (tiers.get(tier) ?? 0) + 1);
  }
  const unresolved: Partial<Record<UnresolvedReason, number>> = {};
  for (const u of graph.unresolved) {
    unresolved[u.reason] = (unresolved[u.reason] ?? 0) + 1;
  }
  const candidates = { high: 0, medium: 0, low: 0 };
  for (const f of openFindings(s)) candidates[f.confidence]++;
  const hints = graph.edges.filter(isHintEdge).length;
  return {
    epochVersion: meta.epochVersion,
    files: meta.counts.filesAnalyzed,
    nodes: graph.nodes.length,
    factEdges: graph.edges.length - hints,
    likelyRelations: hints,
    languages: [...languages]
      .sort(([a, x], [b, y]) => y - x || compareCodeUnits(a, b))
      .map(([language, nodes]) => {
        const tier = LANGUAGE_TIERS[language];
        return { language, nodes, ...(tier === undefined ? {} : { tier }) };
      }),
    unresolved,
    cycles: meta.cycles.length,
    git: meta.git.status,
    coverageReports: meta.coverage.reports.map((r) => r.source),
    ...(tiers.size === 0
      ? {}
      : {
          riskTiers: Object.fromEntries(
            RISK_TIERS.map((t) => [t, tiers.get(t) ?? 0]),
          ) as Record<RiskTier, number>,
        }),
    candidates,
    mostDependedOn: mostDependedOn(graph, TOP).map((n) => ({
      id: n.id,
      dependents: n.metrics.dependents ?? n.metrics.fanIn,
    })),
    riskiest: riskList(s, {}, TOP).nodes.map((n) => ({
      id: n.id,
      tier: n.tier,
    })),
  };
}

export interface RiskRow {
  readonly id: string;
  readonly tier: RiskTier;
  readonly archetype: string;
  readonly dependents: number;
  readonly commits90d: number;
  readonly lines: number;
  readonly coverage?: number;
}

/** Nodes by risk: tier, then dependents, then churn (CLAUDE.md "Risk tiers"). */
export function riskList(
  s: Snapshot,
  filter: { readonly tier?: RiskTier },
  limit: number,
): {
  readonly nodes: readonly RiskRow[];
  readonly total: number;
  /** Why no node has a tier, when none does. */
  readonly unavailable?: string;
} {
  const rows = s.graph.nodes
    .filter(
      (n) =>
        n.metrics.risk !== undefined &&
        (filter.tier === undefined || n.metrics.risk.tier === filter.tier),
    )
    .sort(compareByRisk)
    .flatMap((n): RiskRow[] => {
      const { risk, dependents, churn90d, coverage } = n.metrics;
      if (!risk) return [];
      return [
        {
          id: n.id,
          tier: risk.tier,
          archetype: risk.archetype,
          dependents: dependents ?? 0,
          commits90d: churn90d ?? 0,
          lines: n.loc,
          ...(coverage === undefined ? {} : { coverage }),
        },
      ];
    });
  const none = !s.graph.nodes.some((n) => n.metrics.risk !== undefined);
  return {
    nodes: rows.slice(0, limit),
    total: rows.length,
    ...(none
      ? {
          unavailable: `No risk tiers: they need git history (${s.meta.git.status}).`,
        }
      : {}),
  };
}

/** Open candidates, most confident first, optionally for one kind or file. */
export function findingsList(
  s: Snapshot,
  filter: {
    readonly kind?: FindingKind;
    readonly minConfidence?: Confidence;
    /** A node id: only candidates located in it (or its members). */
    readonly node?: string;
  },
  limit: number,
): {
  readonly findings: readonly Finding[];
  readonly total: number;
  readonly minConfidence: Confidence;
} {
  const minConfidence = filter.minConfidence ?? s.meta.findings.minConfidence;
  const files =
    filter.node === undefined
      ? undefined
      : new Set([filter.node, ...(s.packages.get(filter.node) ?? [])]);
  const rank: Record<Confidence, number> = { high: 0, medium: 1, low: 2 };
  const matching = openFindings(s)
    .filter(
      (f) =>
        atLeast(f.confidence, minConfidence) &&
        (filter.kind === undefined || f.kind === filter.kind) &&
        (files === undefined || f.locations.some((l) => files.has(l.file))),
    )
    .sort(
      (a, b) =>
        rank[a.confidence] - rank[b.confidence] ||
        compareCodeUnits(a.kind, b.kind) ||
        compareCodeUnits(a.subject.name, b.subject.name) ||
        compareCodeUnits(a.id, b.id),
    );
  return {
    findings: matching.slice(0, limit),
    total: matching.length,
    minConfidence,
  };
}
