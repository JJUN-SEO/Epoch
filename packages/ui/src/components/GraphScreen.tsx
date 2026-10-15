import { useMemo, useState } from "react";
import type { Graph, ProjectInfo } from "@epoch-dev/core";
import {
  aggregate,
  ancestors,
  dirPath,
  expandTo,
  initialExpanded,
  isDirId,
  searchNodes,
} from "../graph/aggregate";
import { GraphView } from "../graph/GraphView";
import { DetailsPanel } from "./DetailsPanel";

export interface GraphScreenProps {
  readonly project: ProjectInfo;
  readonly graph: Graph;
  /** Absent in the static demo, which opens nothing. */
  readonly onOpenAnother?: () => void;
}

export function GraphScreen({
  project,
  graph,
  onOpenAnother,
}: GraphScreenProps) {
  const [expanded, setExpanded] = useState(() => initialExpanded(graph));
  const [showViaBarrel, setShowViaBarrel] = useState(false);
  const [selected, setSelected] = useState<string | undefined>();
  const [focus, setFocus] = useState<{ id: string } | undefined>();
  const [query, setQuery] = useState("");

  const visible = useMemo(
    () => aggregate(graph, { expanded, showViaBarrel }),
    [graph, expanded, showViaBarrel],
  );
  const matches = useMemo(() => searchNodes(graph, query), [graph, query]);

  /** Selects a node, opening the folders above it, and centers on it. */
  const show = (id: string) => {
    setExpanded((e) => expandTo(e, id));
    setSelected(id);
    setFocus({ id });
  };

  const toggleDir = (id: string) => {
    const dir = dirPath(id);
    setExpanded((e) => {
      const next = new Set(e);
      if (next.has(dir)) {
        for (const d of next) {
          if (d === dir || d.startsWith(`${dir}/`)) next.delete(d);
        }
      } else {
        next.add(dir);
      }
      return next;
    });
  };

  const allDirs = useMemo(
    () => new Set(graph.nodes.flatMap((n) => ancestors(n.id))),
    [graph],
  );

  return (
    <div className="flex h-full flex-col">
      <header className="flex flex-wrap items-center gap-3 border-b border-neutral-200 px-4 py-2 dark:border-neutral-800">
        <div className="min-w-0">
          <h1 className="truncate font-semibold" title={project.root}>
            {project.name}
          </h1>
          <p className="text-xs text-neutral-500" data-testid="graph-stats">
            {graph.nodes.length} files · {graph.edges.length} edges
            {graph.unresolved.length > 0
              ? ` · ${String(graph.unresolved.length)} unresolved imports`
              : ""}
          </p>
        </div>
        <div className="relative ml-auto">
          <input
            type="search"
            placeholder="Find a file…"
            aria-label="Find a file"
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
            }}
            className="w-64 rounded border border-neutral-300 bg-transparent px-2 py-1 text-sm dark:border-neutral-700"
          />
          {matches.length > 0 && (
            <ul
              className="absolute right-0 z-10 mt-1 max-h-80 w-96 overflow-auto rounded border border-neutral-300 bg-white shadow dark:border-neutral-700 dark:bg-neutral-900"
              aria-label="Search results"
            >
              {matches.map((id) => (
                <li key={id}>
                  <button
                    type="button"
                    className="w-full px-2 py-1 text-left text-sm break-all hover:bg-neutral-100 dark:hover:bg-neutral-800"
                    onClick={() => {
                      show(id);
                      setQuery("");
                    }}
                  >
                    {id}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
        <label className="flex items-center gap-1 text-sm">
          <input
            type="checkbox"
            checked={showViaBarrel}
            onChange={(e) => {
              setShowViaBarrel(e.target.checked);
            }}
          />
          Barrel imports
        </label>
        <button
          type="button"
          className="text-sm text-blue-700 hover:underline dark:text-blue-300"
          onClick={() => {
            setExpanded(new Set(allDirs));
          }}
        >
          Expand all
        </button>
        <button
          type="button"
          className="text-sm text-blue-700 hover:underline dark:text-blue-300"
          onClick={() => {
            setExpanded(new Set());
          }}
        >
          Collapse all
        </button>
        {onOpenAnother && (
          <button
            type="button"
            className="rounded border border-neutral-300 px-2 py-1 text-sm dark:border-neutral-700"
            onClick={onOpenAnother}
          >
            Open…
          </button>
        )}
      </header>
      <div className="flex min-h-0 flex-1">
        <div className="min-w-0 flex-1">
          <GraphView
            visible={visible}
            selected={selected}
            focus={focus}
            onSelect={setSelected}
            onToggleDir={toggleDir}
          />
        </div>
        <aside
          className="w-96 shrink-0 overflow-auto border-l border-neutral-200 p-4 dark:border-neutral-800"
          aria-label="Details"
        >
          <DetailsPanel graph={graph} selected={selected} onShow={show} />
          {selected !== undefined && isDirId(selected) && (
            <button
              type="button"
              className="mt-4 text-sm text-blue-700 hover:underline dark:text-blue-300"
              onClick={() => {
                toggleDir(selected);
              }}
            >
              {expanded.has(dirPath(selected)) ? "Close folder" : "Open folder"}
            </button>
          )}
        </aside>
      </div>
    </div>
  );
}
