import { Crosshair, FolderOpen, FolderClosed } from "lucide-react";
import {
  LANGUAGE_TIERS,
  RISK_DEFAULTS,
  assessRisk,
  hintSourceLabel,
  isHintEdge,
  isScoredNode,
  type AnalysisInfo,
  type Graph,
  type GraphEdge,
  type GraphNode,
  type RiskArchetype,
} from "@epoch-dev/core";
import { ancestors, dirPath, isDirId } from "../graph/aggregate";
import { RISK_TIER_LABELS, riskColor } from "../graph/colors";
import { languageName } from "../languages";
import { gitSummary } from "../shell/StatusBar";
import {
  SummarySection,
  type SummarySectionProps,
} from "../summaries/SummarySection";
import { Button, PathLabel, SectionTitle } from "./ui";

export interface DetailsPanelProps {
  readonly graph: Graph;
  /** What the analysis used (git history, coverage), to explain a missing risk tier. */
  readonly analysis?: AnalysisInfo | null;
  readonly selected: string | undefined;
  /** Select and show a node (expanding folders as needed). */
  readonly onShow: (id: string) => void;
  /** Open the selected file in the focus view. */
  readonly onFocus: (id: string) => void;
  /** Directories: whether the folder is open in the graph, and the toggle. */
  readonly folderOpen: boolean;
  readonly onToggleFolder: (id: string) => void;
  /** Model summaries (the desktop app); absent in the static demo. */
  readonly summary?: Omit<SummarySectionProps, "subject"> | undefined;
}

function EdgeList(props: {
  readonly title: string;
  readonly tone: "imports" | "dependents";
  readonly edges: readonly GraphEdge[];
  readonly other: (e: GraphEdge) => string;
  readonly onShow: (id: string) => void;
}) {
  if (props.edges.length === 0) return null;
  return (
    <section>
      <SectionTitle>
        <span className="inline-flex items-center gap-1.5">
          <span
            aria-hidden="true"
            className={`size-2 rounded-full ${props.tone === "imports" ? "bg-imports" : "bg-dependents"}`}
          />
          {props.title} ({props.edges.length})
        </span>
      </SectionTitle>
      <ul className="px-1.5">
        {props.edges.map((e) => (
          <li key={`${e.source}>${e.target}>${e.kind}`}>
            <div className="hover:bg-hover rounded-md px-1.5 py-1">
              <button
                type="button"
                className="block w-full text-left text-[13px]"
                onClick={() => {
                  props.onShow(props.other(e));
                }}
              >
                <PathLabel id={props.other(e)} />
              </button>
              <div className="mt-0.5 flex flex-wrap items-center gap-1.5">
                <span
                  className={`text-muted rounded px-1 text-[11px] ${
                    e.confidence < 1
                      ? "border-strong-line border border-dashed"
                      : "bg-sunken"
                  }`}
                >
                  {e.kind}
                </span>
                {e.evidence.map((ev) => (
                  <span key={ev} className="text-muted selectable text-[11px]">
                    {ev}
                  </span>
                ))}
              </div>
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}

/** Hint edges around a node, one row per other node, the most likely first. */
export function likelyRelations(
  graph: Graph,
  id: string,
): {
  other: string;
  confidence: number;
  sources: string[];
  evidence: string[];
}[] {
  const byOther = new Map<string, GraphEdge[]>();
  for (const e of graph.edges) {
    if (!isHintEdge(e) || e.source === e.target) continue;
    const other =
      e.source === id ? e.target : e.target === id ? e.source : undefined;
    if (other === undefined) continue;
    byOther.set(other, [...(byOther.get(other) ?? []), e]);
  }
  return [...byOther]
    .map(([other, edges]) => ({
      other,
      confidence: Math.max(...edges.map((e) => e.confidence)),
      sources: [...new Set(edges.map(hintSourceLabel))].sort(),
      evidence: [...new Set(edges.flatMap((e) => e.evidence))],
    }))
    .sort(
      (a, b) =>
        b.confidence - a.confidence ||
        (a.other < b.other ? -1 : a.other > b.other ? 1 : 0),
    );
}

/** Likely relations (hints): inferred, never proven, so set apart from imports. */
function LikelyList(props: {
  readonly graph: Graph;
  readonly id: string;
  readonly onShow: (id: string) => void;
}) {
  const rows = likelyRelations(props.graph, props.id);
  if (rows.length === 0) return null;
  return (
    <section data-testid="likely-related">
      <SectionTitle>Likely related ({rows.length})</SectionTitle>
      <p className="text-muted px-3 pb-1 text-[11px]">
        Inferred from git history and shared strings, not from imports. They may
        change together; check before relying on it.
      </p>
      <ul className="px-1.5">
        {rows.map((r) => (
          <li key={r.other}>
            <div className="hover:bg-hover rounded-md px-1.5 py-1">
              <button
                type="button"
                className="block w-full text-left text-[13px]"
                onClick={() => {
                  props.onShow(r.other);
                }}
              >
                <PathLabel id={r.other} />
              </button>
              <div className="mt-0.5 flex flex-wrap items-center gap-1.5">
                <span className="text-muted border-strong-line rounded border border-dashed px-1 text-[11px] tabular-nums">
                  likely {r.confidence.toFixed(2)} · {r.sources.join(", ")}
                </span>
                {r.evidence.map((ev) => (
                  <span key={ev} className="text-muted selectable text-[11px]">
                    {ev}
                  </span>
                ))}
              </div>
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}

function Stat(props: { readonly label: string; readonly value: string }) {
  return (
    <div className="bg-sunken rounded-md px-2 py-1.5">
      <dt className="text-muted text-[11px]">{props.label}</dt>
      <dd className="text-[15px] font-semibold tabular-nums">{props.value}</dd>
    </div>
  );
}

function Row(props: { readonly label: string; readonly value: string }) {
  return (
    <div className="flex justify-between gap-4 px-3 py-0.5">
      <dt className="text-muted">{props.label}</dt>
      <dd className="text-right break-all">{props.value}</dd>
    </div>
  );
}

function Header(props: {
  readonly id: string;
  readonly sub?: string;
  readonly actions?: React.ReactNode;
}) {
  return (
    <header className="border-line border-b px-3 pt-3 pb-3">
      <h2 className="selectable text-[14px] leading-snug font-semibold">
        <PathLabel id={props.id} />
      </h2>
      {props.sub !== undefined && (
        <p className="text-muted mt-1 text-xs">{props.sub}</p>
      )}
      {props.actions !== undefined && (
        <div className="mt-2.5 flex gap-2">{props.actions}</div>
      )}
    </header>
  );
}

const ARCHETYPES: Readonly<
  Record<RiskArchetype, { readonly name: string; readonly meaning: string }>
> = {
  "volatile-core": {
    name: "Volatile core",
    meaning:
      "Many files depend on it, it changes often, and it is large or thinly tested: a change here is likely to break something.",
  },
  "active-hotspot": {
    name: "Active hotspot",
    meaning: "A shared dependency that is actively changing.",
  },
  "warm-core": {
    name: "Warm core",
    meaning: "A shared dependency that changes now and then.",
  },
  "fragile-leaf": {
    name: "Fragile leaf",
    meaning:
      "Few files depend on it, but it changes often or is large and changing: bugs stay local, but are likely.",
  },
  "frozen-core": {
    name: "Frozen core",
    meaning:
      "Many files depend on it, but it has not changed in 90 days: stable, and worth care when touched.",
  },
  "stable-leaf": {
    name: "Stable leaf",
    meaning: "Few dependents and little recent change.",
  },
};

const plural = (n: number, one: string) =>
  `${String(n)} ${one}${n === 1 ? "" : "s"}`;

/**
 * The risk tier, its archetype and the three facts behind it (CLAUDE.md
 * "Risk tiers", ADR-015), or why there is none. No score: each line says
 * what was counted and which side of its threshold it fell on.
 */
function RiskSection(props: {
  readonly node: GraphNode;
  readonly analysis: AnalysisInfo | null;
}) {
  const { node } = props;
  if (!isScoredNode(node)) return null;
  const m = node.metrics;
  if (!m.risk || m.churn90d === undefined) {
    const why =
      gitSummary(props.analysis)?.title ??
      "Risk needs git history (90 days of commits).";
    return (
      <section data-testid="risk">
        <SectionTitle>Risk</SectionTitle>
        <p className="text-muted px-3 text-[12px]">{why}</p>
      </section>
    );
  }
  const t = RISK_DEFAULTS;
  const a = assessRisk({
    dependents: m.dependents ?? 0,
    churn90d: m.churn90d,
    loc: node.loc,
    ...(m.coverage === undefined ? {} : { coverage: m.coverage }),
  });
  const archetype = ARCHETYPES[m.risk.archetype];
  const facts = [
    {
      label: a.exposure === "exposed" ? "Exposed" : "Contained",
      text: `${plural(m.dependents ?? 0, "file")} ${(m.dependents ?? 0) === 1 ? "depends" : "depend"} on it (exposed above ${String(t.exposedAbove)})`,
    },
    {
      label:
        a.change === "hot" ? "Hot" : a.change === "warm" ? "Warm" : "Quiet",
      text: `${plural(m.churn90d, "commit")} in 90 days (hot from ${String(t.hotFrom)})`,
    },
    {
      label: a.fragility === "fragile" ? "Fragile" : "Sturdy",
      text:
        m.coverage === undefined
          ? `${plural(node.loc, "line")}, no coverage report (fragile above ${String(t.fragileAboveLoc)} lines)`
          : `${plural(node.loc, "line")}, ${(m.coverage * 100).toFixed(0)}% covered (fragile above ${String(t.fragileAboveLoc)} lines or below ${String(t.fragileBelowCoverage * 100)}% coverage)`,
    },
  ];
  return (
    <section data-testid="risk">
      <SectionTitle>Risk</SectionTitle>
      <div className="flex items-baseline gap-2 px-3">
        <span
          aria-hidden="true"
          className="size-2.5 self-center rounded-full"
          style={{ backgroundColor: riskColor(m.risk.tier) }}
        />
        <span data-testid="risk-tier" className="text-[15px] font-semibold">
          {RISK_TIER_LABELS[m.risk.tier]}
        </span>
        <span className="text-muted text-[12px]">{archetype.name}</span>
      </div>
      <p className="text-muted mt-1 px-3 text-[12px]">{archetype.meaning}</p>
      <ul className="mt-1.5 space-y-0.5 px-3 text-[12px]">
        {facts.map((f) => (
          <li key={f.label}>
            <span className="font-medium">{f.label}:</span>{" "}
            <span className="text-muted">{f.text}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}

/** Facts about the selected node. Repository strings render as text only. */
export function DetailsPanel({
  graph,
  analysis = null,
  selected,
  onShow,
  onFocus,
  folderOpen,
  onToggleFolder,
  summary,
}: DetailsPanelProps) {
  if (selected === undefined) {
    return (
      <p className="text-muted px-4 py-6 text-center text-[13px]">
        Select a file or folder to see its imports, exports and dependents.
        Double-click a file to focus on it.
      </p>
    );
  }

  if (isDirId(selected)) {
    const dir = dirPath(selected);
    const files = graph.nodes.filter((n) =>
      ancestors(n.id, graph).includes(dir),
    );
    return (
      <div data-testid="details">
        <Header
          id={`${dir}/`}
          sub="Folder"
          actions={
            <Button
              icon={folderOpen ? FolderClosed : FolderOpen}
              onClick={() => {
                onToggleFolder(selected);
              }}
            >
              {folderOpen ? "Close folder" : "Open folder"}
            </Button>
          }
        />
        <dl className="py-2">
          <Row label="Files" value={String(files.length)} />
        </dl>
        {summary && (
          <SummarySection key={selected} subject={selected} {...summary} />
        )}
        <ul className="px-1.5 pb-3">
          {files.slice(0, 200).map((f) => (
            <li key={f.id}>
              <button
                type="button"
                className="hover:bg-hover block w-full rounded-md px-1.5 py-0.5 text-left text-[13px]"
                onClick={() => {
                  onShow(f.id);
                }}
              >
                {f.id.startsWith(`${dir}/`) ? f.id.slice(dir.length + 1) : f.id}
              </button>
            </li>
          ))}
        </ul>
        {files.length > 200 && (
          <p className="text-muted px-3 pb-3 text-xs">
            and {files.length - 200} more
          </p>
        )}
      </div>
    );
  }

  const node = graph.nodes.find((n) => n.id === selected);
  if (!node) return null;
  const outgoing = graph.edges.filter(
    (e) => e.source === node.id && !isHintEdge(e),
  );
  const incoming = graph.edges.filter(
    (e) => e.target === node.id && !isHintEdge(e),
  );
  const unresolved = graph.unresolved.filter((u) => u.from === node.id);
  const tier = LANGUAGE_TIERS[node.language];

  return (
    <div data-testid="details" className="pb-4">
      <Header
        id={node.id}
        sub={`${languageName(node.language)}${tier === undefined ? "" : ` · tier ${tier}${tier === "B" ? " (best-effort resolution)" : ""}`}`}
        actions={
          <Button
            icon={Crosshair}
            onClick={() => {
              onFocus(node.id);
            }}
          >
            Focus
          </Button>
        }
      />
      <dl className="grid grid-cols-3 gap-1.5 px-3 pt-3">
        <Stat label="Lines" value={String(node.loc)} />
        <Stat label="Imported by" value={String(node.metrics.fanIn)} />
        <Stat label="Imports" value={String(node.metrics.fanOut)} />
      </dl>
      {summary && (
        <SummarySection key={node.id} subject={node.id} {...summary} />
      )}
      <RiskSection node={node} analysis={analysis} />
      {node.exports.length > 0 && (
        <section>
          <SectionTitle>Exports ({node.exports.length})</SectionTitle>
          <p className="selectable px-3 font-mono text-xs break-words">
            {node.exports.join(", ")}
          </p>
        </section>
      )}
      {node.externals.length > 0 && (
        <section>
          <SectionTitle>
            Third-party packages ({node.externals.length})
          </SectionTitle>
          <p className="selectable px-3 font-mono text-xs break-words">
            {node.externals.join(", ")}
          </p>
        </section>
      )}
      <EdgeList
        title="Imports"
        tone="imports"
        edges={outgoing}
        other={(e) => e.target}
        onShow={onShow}
      />
      <EdgeList
        title="Imported by"
        tone="dependents"
        edges={incoming}
        other={(e) => e.source}
        onShow={onShow}
      />
      <LikelyList graph={graph} id={node.id} onShow={onShow} />
      {unresolved.length > 0 && (
        <section>
          <SectionTitle>Unresolved imports ({unresolved.length})</SectionTitle>
          <ul className="space-y-1 px-3">
            {unresolved.map((u) => (
              <li key={`${String(u.line)}:${u.specifier ?? ""}`}>
                <code className="selectable font-mono text-xs break-all">
                  {u.specifier ?? "(computed)"}
                </code>
                <span className="text-muted ml-2 text-[11px]">
                  line {u.line}, {u.reason}
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
