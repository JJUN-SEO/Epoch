import type { Graph, GraphEdge } from "@epoch-dev/core";
import { dirPath, isDirId } from "../graph/aggregate";

export interface DetailsPanelProps {
  readonly graph: Graph;
  readonly selected: string | undefined;
  /** Select and show a node (expanding folders as needed). */
  readonly onShow: (id: string) => void;
}

function EdgeList(props: {
  readonly title: string;
  readonly edges: readonly GraphEdge[];
  readonly other: (e: GraphEdge) => string;
  readonly onShow: (id: string) => void;
}) {
  if (props.edges.length === 0) return null;
  return (
    <section className="mt-4">
      <h3 className="text-xs font-semibold tracking-wide text-neutral-500 uppercase">
        {props.title} ({props.edges.length})
      </h3>
      <ul className="mt-1 space-y-1">
        {props.edges.map((e) => (
          <li key={`${e.source}>${e.target}>${e.kind}`} className="text-sm">
            <button
              type="button"
              className="text-left break-all text-blue-700 hover:underline dark:text-blue-300"
              onClick={() => {
                props.onShow(props.other(e));
              }}
            >
              {props.other(e)}
            </button>
            <span
              className={`ml-2 rounded px-1 text-xs ${
                e.confidence < 1
                  ? "border border-dashed border-neutral-400"
                  : "bg-neutral-200 dark:bg-neutral-700"
              }`}
            >
              {e.kind}
            </span>
            {e.evidence.map((ev) => (
              <div key={ev} className="ml-3 text-xs text-neutral-500">
                {ev}
              </div>
            ))}
          </li>
        ))}
      </ul>
    </section>
  );
}

function Row(props: { readonly label: string; readonly value: string }) {
  return (
    <div className="flex justify-between gap-4 text-sm">
      <dt className="text-neutral-500">{props.label}</dt>
      <dd className="text-right break-all">{props.value}</dd>
    </div>
  );
}

/** Facts about the selected node. Repository strings render as text only. */
export function DetailsPanel({ graph, selected, onShow }: DetailsPanelProps) {
  if (selected === undefined) {
    return (
      <p className="text-sm text-neutral-500">
        Select a file or folder to see its imports, exports and dependents.
        Double-click a folder to open or close it.
      </p>
    );
  }

  if (isDirId(selected)) {
    const dir = dirPath(selected);
    const files = graph.nodes.filter((n) => n.id.startsWith(`${dir}/`));
    return (
      <div data-testid="details">
        <h2 className="font-semibold break-all">{dir}/</h2>
        <dl className="mt-2 space-y-1">
          <Row label="Files" value={String(files.length)} />
        </dl>
        <ul className="mt-3 space-y-1">
          {files.slice(0, 200).map((f) => (
            <li key={f.id}>
              <button
                type="button"
                className="text-left text-sm break-all text-blue-700 hover:underline dark:text-blue-300"
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
          <p className="mt-2 text-xs text-neutral-500">
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

  return (
    <div data-testid="details">
      <h2 className="font-semibold break-all">{node.id}</h2>
      <dl className="mt-2 space-y-1">
        <Row label="Language" value={node.language} />
        <Row label="Lines of code" value={String(node.loc)} />
        <Row label="Imported by (fan-in)" value={String(node.metrics.fanIn)} />
        <Row label="Imports (fan-out)" value={String(node.metrics.fanOut)} />
      </dl>
      {node.exports.length > 0 && (
        <section className="mt-4">
          <h3 className="text-xs font-semibold tracking-wide text-neutral-500 uppercase">
            Exports ({node.exports.length})
          </h3>
          <p className="mt-1 text-sm break-words">{node.exports.join(", ")}</p>
        </section>
      )}
      {node.externals.length > 0 && (
        <section className="mt-4">
          <h3 className="text-xs font-semibold tracking-wide text-neutral-500 uppercase">
            Third-party packages ({node.externals.length})
          </h3>
          <p className="mt-1 text-sm break-words">
            {node.externals.join(", ")}
          </p>
        </section>
      )}
      <EdgeList
        title="Imports"
        edges={outgoing}
        other={(e) => e.target}
        onShow={onShow}
      />
      <EdgeList
        title="Imported by"
        edges={incoming}
        other={(e) => e.source}
        onShow={onShow}
      />
      {unresolved.length > 0 && (
        <section className="mt-4">
          <h3 className="text-xs font-semibold tracking-wide text-neutral-500 uppercase">
            Unresolved imports ({unresolved.length})
          </h3>
          <ul className="mt-1 space-y-1 text-sm">
            {unresolved.map((u) => (
              <li key={`${String(u.line)}:${u.specifier ?? ""}`}>
                <code className="break-all">{u.specifier ?? "(computed)"}</code>
                <span className="ml-2 text-xs text-neutral-500">
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
