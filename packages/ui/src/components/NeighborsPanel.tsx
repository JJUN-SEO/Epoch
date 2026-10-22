import { Crosshair, Repeat } from "lucide-react";
import type { Graph } from "@epoch-dev/core";
import { basename, isDirId } from "../graph/aggregate";
import type { Neighbor, Neighborhood } from "../graph/neighborhood";
import { IconButton, PathLabel, Segmented, SectionTitle } from "./ui";

export type Hops = 1 | 2 | 3;

export interface NeighborsPanelProps {
  readonly graph: Graph;
  readonly selected: string | undefined;
  /** The neighborhood of the selected file, when a file is selected. */
  readonly hood: Neighborhood | undefined;
  readonly hops: Hops;
  readonly onHops: (hops: Hops) => void;
  readonly onSelect: (id: string) => void;
  readonly onFocus: (id: string) => void;
}

export const HOP_OPTIONS = [
  { value: 1, label: "1", title: "Direct neighbors" },
  { value: 2, label: "2", title: "Up to 2 hops" },
  { value: 3, label: "3", title: "Up to 3 hops" },
] as const;

function Side(props: {
  readonly title: string;
  readonly tone: "imports" | "dependents";
  readonly rows: readonly {
    readonly n: Neighbor;
    readonly depth: number;
    readonly via?: string | undefined;
  }[];
  readonly center: string;
  readonly kinds: (id: string) => string[];
  readonly onSelect: (id: string) => void;
  readonly onFocus: (id: string) => void;
}) {
  const byDepth = new Map<number, typeof props.rows>();
  for (const r of props.rows) {
    byDepth.set(r.depth, [...(byDepth.get(r.depth) ?? []), r]);
  }
  return (
    <section aria-label={props.title}>
      <SectionTitle>
        <span className="inline-flex items-center gap-1.5">
          <span
            aria-hidden="true"
            className={`size-2 rounded-full ${props.tone === "imports" ? "bg-imports" : "bg-dependents"}`}
          />
          {props.title} ({props.rows.length})
        </span>
      </SectionTitle>
      {props.rows.length === 0 && (
        <p className="text-faint px-3 text-xs">None</p>
      )}
      {[...byDepth.entries()].map(([depth, rows]) => (
        <div key={depth}>
          {byDepth.size > 1 || depth > 1 ? (
            <p className="text-faint px-3 pt-1 text-[11px]">
              {depth === 1 ? "Direct" : `${String(depth)} hops`}
            </p>
          ) : null}
          <ul className="px-1.5">
            {rows.map(({ n, via }) => (
              <li key={n.id} className="group relative">
                <button
                  type="button"
                  aria-label={n.id}
                  className="hover:bg-hover flex w-full items-start gap-1.5 rounded-md py-1 pr-8 pl-1.5 text-left text-[13px]"
                  onClick={() => {
                    props.onSelect(n.id);
                  }}
                >
                  <span className="min-w-0 flex-1">
                    <PathLabel id={n.id} />
                    <span className="text-muted block text-[11px]">
                      {via !== undefined && via !== props.center
                        ? `via ${basename(via)}`
                        : props.kinds(n.id).join(", ")}
                    </span>
                  </span>
                  {n.importDepth !== undefined &&
                    n.dependentDepth !== undefined && (
                      <span
                        title="Imports and is imported by this file (a cycle)"
                        className="text-dependents mt-0.5"
                      >
                        <Repeat size={13} aria-label="cycle" />
                      </span>
                    )}
                </button>
                <span className="absolute top-1 right-1 opacity-0 group-focus-within:opacity-100 group-hover:opacity-100">
                  <IconButton
                    icon={Crosshair}
                    label={`Focus on ${n.id}`}
                    className="size-6"
                    onClick={() => {
                      props.onFocus(n.id);
                    }}
                  />
                </span>
              </li>
            ))}
          </ul>
        </div>
      ))}
    </section>
  );
}

/**
 * What the selected file imports and what imports it, within a few hops.
 * Beyond one hop the dependents list previews, but is not, blast radius
 * (M4 computes that with the traversal policy).
 */
export function NeighborsPanel(props: NeighborsPanelProps) {
  const { hood, selected } = props;
  if (selected === undefined || isDirId(selected) || hood === undefined) {
    return (
      <p className="text-muted px-4 py-6 text-center text-[13px]">
        Select a file to see the files around it.
      </p>
    );
  }
  const kinds = (from: string, to: string) =>
    [
      ...new Set(
        props.graph.edges
          .filter((e) => e.source === from && e.target === to)
          .map((e) => e.kind),
      ),
    ].sort();
  const imports = hood.neighbors
    .filter((n) => n.importDepth !== undefined)
    .map((n) => ({ n, depth: n.importDepth ?? 0, via: n.importVia }))
    .sort((a, b) => a.depth - b.depth || (a.n.id < b.n.id ? -1 : 1));
  const dependents = hood.neighbors
    .filter((n) => n.dependentDepth !== undefined)
    .map((n) => ({ n, depth: n.dependentDepth ?? 0, via: n.dependentVia }))
    .sort((a, b) => a.depth - b.depth || (a.n.id < b.n.id ? -1 : 1));

  return (
    <div data-testid="neighbors" className="pb-4">
      <header className="border-line flex items-center justify-between gap-2 border-b px-3 py-2.5">
        <h2
          className="min-w-0 truncate text-[13px] font-semibold"
          title={selected}
        >
          Around {basename(selected)}
        </h2>
        <Segmented
          label="Hops"
          options={HOP_OPTIONS}
          value={props.hops}
          onChange={props.onHops}
        />
      </header>
      <Side
        title="Imports"
        tone="imports"
        rows={imports}
        center={selected}
        kinds={(id) => kinds(selected, id)}
        onSelect={props.onSelect}
        onFocus={props.onFocus}
      />
      <Side
        title="Imported by"
        tone="dependents"
        rows={dependents}
        center={selected}
        kinds={(id) => kinds(id, selected)}
        onSelect={props.onSelect}
        onFocus={props.onFocus}
      />
      <p className="text-faint px-3 pt-3 text-[11px]">
        Click a file to walk to it; the crosshair focuses on it.
      </p>
    </div>
  );
}
