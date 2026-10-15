import { Crosshair, FolderOpen, FolderClosed } from "lucide-react";
import { LANGUAGE_TIERS, type Graph, type GraphEdge } from "@epoch-dev/core";
import { dirPath, isDirId } from "../graph/aggregate";
import { languageName } from "../languages";
import { Button, PathLabel, SectionTitle } from "./ui";

export interface DetailsPanelProps {
  readonly graph: Graph;
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

/** Facts about the selected node. Repository strings render as text only. */
export function DetailsPanel({
  graph,
  selected,
  onShow,
  onFocus,
  folderOpen,
  onToggleFolder,
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
    const files = graph.nodes.filter((n) => n.id.startsWith(`${dir}/`));
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
                {f.id.slice(dir.length + 1)}
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
  const outgoing = graph.edges.filter((e) => e.source === node.id);
  const incoming = graph.edges.filter((e) => e.target === node.id);
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
