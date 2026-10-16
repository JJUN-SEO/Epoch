import { Crosshair, FolderOpen, FolderClosed } from "lucide-react";
import { useMemo } from "react";
import {
  LANGUAGE_TIERS,
  hintSourceLabel,
  isHintEdge,
  isScoredNode,
  riskBreakdowns,
  type AnalysisInfo,
  type Graph,
  type GraphEdge,
  type GraphNode,
  type RiskBreakdown,
} from "@epoch-dev/core";
import { ancestors, dirPath, isDirId } from "../graph/aggregate";
import { riskColor } from "../graph/colors";
import { languageName } from "../languages";
import { gitSummary } from "../shell/StatusBar";
import { Button, PathLabel, SectionTitle } from "./ui";

export interface DetailsPanelProps {
  readonly graph: Graph;
  /** What the analysis used (git history, coverage), to explain a missing risk score. */
  readonly analysis?: AnalysisInfo | null;
  readonly selected: string | undefined;
  /** Select and show a node (expanding folders as needed). */
  readonly onShow: (id: string) => void;
  /** Open the selected file in the focus view. */
  readonly onFocus: (id: string) => void;
  /** Directories: whether the folder is open in the graph, and the toggle. */
  readonly folderOpen: boolean;
  readonly onToggleFolder: (id: string) => void;
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

const INPUT_NAMES = {
  fanIn: "Imported by",
  churn: "Changes in 90 days",
  coverage: "Test coverage",
} as const;

const ordinal = (p: number): string => {
  const n = Math.round(p * 100);
  const s =
    n % 100 >= 11 && n % 100 <= 13
      ? "th"
      : (["th", "st", "nd", "rd"][n % 10] ?? "th");
  return `${String(n)}${s}`;
};

/**
 * The risk score and how it was computed (CLAUDE.md "Risk score": percentile
 * ranks across the repository; coverage counts inverted), or why there is none.
 */
function RiskSection(props: {
  readonly node: GraphNode;
  readonly risk: RiskBreakdown | undefined;
  readonly analysis: AnalysisInfo | null;
}) {
  const { node, risk } = props;
  if (!isScoredNode(node)) return null;
  if (!risk) {
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
  return (
    <section data-testid="risk">
      <SectionTitle>Risk</SectionTitle>
      <div className="flex items-baseline gap-2 px-3">
        <span
          aria-hidden="true"
          className="size-2.5 rounded-full"
          style={{ backgroundColor: riskColor(risk.score) }}
        />
        <span
          data-testid="risk-score"
          className="text-[18px] font-semibold tabular-nums"
        >
          {risk.score.toFixed(1)}
        </span>
        <span className="text-muted text-[12px]">of 100</span>
      </div>
      <table className="mt-1.5 w-full text-[12px]">
        <thead className="text-muted text-[11px]">
          <tr>
            <th className="px-3 text-left font-normal">Input</th>
            <th className="text-right font-normal">Value</th>
            <th className="text-right font-normal">Percentile</th>
            <th className="px-3 text-right font-normal">Weight</th>
          </tr>
        </thead>
        <tbody>
          {risk.components.map((c) => (
            <tr key={c.input}>
              <td className="px-3">{INPUT_NAMES[c.input]}</td>
              <td className="text-right tabular-nums">
                {c.input === "coverage"
                  ? `${(c.value * 100).toFixed(0)}%`
                  : c.input === "churn"
                    ? `${String(c.value)} commits`
                    : String(c.value)}
              </td>
              <td className="text-right tabular-nums">
                {ordinal(c.percentile)}
              </td>
              <td className="px-3 text-right tabular-nums">{c.weight}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="text-muted mt-1.5 px-3 text-[11px]">
        {risk.missing.includes("coverage")
          ? "No coverage for this file: fan-in and churn only (weights 0.55 and 0.45)."
          : "Lower coverage raises risk (its percentile counts inverted)."}
      </p>
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
}: DetailsPanelProps) {
  const risks = useMemo(() => riskBreakdowns(graph), [graph]);
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
      <RiskSection node={node} risk={risks.get(node.id)} analysis={analysis} />
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
