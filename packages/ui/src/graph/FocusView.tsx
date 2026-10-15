import type {
  Core,
  ElementDefinition,
  EventObject,
  NodeSingular,
} from "cytoscape";
import {
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
  type Ref,
} from "react";
import type { Graph } from "@epoch-dev/core";
import type { NodeColors } from "./colors";
import {
  controlsFor,
  createCy,
  fitWithin,
  highlightNeighbors,
  type CanvasControls,
} from "./cy";
import type { FocusLayout, FocusNode } from "./focus-layout";
import { focusStylesheet } from "./style";
import { onThemeChange, readCanvasTheme } from "./theme";

export interface FocusViewProps {
  /** Shown (the canvas resizes when it becomes visible again). */
  readonly active: boolean;
  readonly graph: Graph;
  readonly layout: FocusLayout;
  readonly colors: NodeColors;
  readonly selected: string | undefined;
  readonly onSelect: (id: string | undefined) => void;
  /** Double-click: a file becomes the new center, a group opens or closes. */
  readonly onActivate: (id: string) => void;
  readonly onContextMenu: (id: string, x: number, y: number) => void;
  readonly controlsRef?: Ref<CanvasControls | undefined>;
}

const MAX_FIT_ZOOM = 1.2;

/**
 * The node whose neighbors stay highlighted: the selection, unless it is the
 * center, whose neighborhood is the whole view (fading it would hide the
 * outer hops).
 */
const emphasized = (p: FocusViewProps): string | undefined =>
  p.layout.nodes.some((n) => n.id === p.selected && n.kind === "center")
    ? undefined
    : p.selected;
const ANIMATION_MS = 280;

const labelOf = (n: FocusNode): string => {
  if (n.kind === "group") return `${n.label}/ (${String(n.members.length)})`;
  const name = n.cycle ? `↻ ${n.label}` : n.label;
  return n.detail === "" ? name : `${name}\n${n.detail}`;
};

function elementsOf(
  graph: Graph,
  layout: FocusLayout,
  colors: NodeColors,
): ElementDefinition[] {
  const language = new Map(graph.nodes.map((n) => [n.id, n.language]));
  const side = new Map(layout.nodes.map((n) => [n.id, n.side]));
  return [
    ...layout.nodes.map((n) => ({
      group: "nodes" as const,
      data: {
        id: n.id,
        label: labelOf(n),
        kind: n.kind,
        side: n.side,
        cycle: n.cycle,
        color:
          n.kind === "group"
            ? colors.colorOf(
                n.members[0] ?? "",
                language.get(n.members[0] ?? ""),
              )
            : colors.colorOf(n.id, language.get(n.id)),
      },
      position: { ...n.position },
    })),
    ...layout.edges.map((e) => ({
      group: "edges" as const,
      data: {
        id: e.id,
        source: e.source,
        target: e.target,
        hint: e.hint,
        outward: e.outward,
        // Into the center, or out of a dependent: the dependents' direction.
        dir:
          side.get(e.target) === "center" || side.get(e.source) === "dependents"
            ? "dependents"
            : "imports",
        width: Math.min(4, 1.2 + Math.log2(e.count)),
      },
    })),
  ];
}

/**
 * One file and its neighbors: what it imports on the right, what imports it
 * on the left, one column per hop (focus-layout.ts). When the center changes,
 * files present in both layouts glide to their new places.
 */
export function FocusView(props: FocusViewProps) {
  const container = useRef<HTMLDivElement>(null);
  const cyRef = useRef<Core | undefined>(undefined);
  const handlers = useRef(props);
  handlers.current = props;
  const [drawn, setDrawn] = useState(0);

  useImperativeHandle(
    props.controlsRef,
    () => {
      const controls = () =>
        cyRef.current && controlsFor(cyRef.current, MAX_FIT_ZOOM);
      return {
        zoomIn: () => {
          controls()?.zoomIn();
        },
        zoomOut: () => {
          controls()?.zoomOut();
        },
        fit: () => {
          controls()?.fit();
        },
      };
    },
    [],
  );

  useEffect(() => {
    if (!container.current) return;
    const cy = createCy(container.current, focusStylesheet(readCanvasTheme()));
    cy.autoungrabify(true);
    const nodeId = (e: EventObject) => (e.target as NodeSingular).id();
    cy.on("tap", "node", (e) => {
      handlers.current.onSelect(nodeId(e));
    });
    cy.on("tap", (e) => {
      if (e.target === cy) handlers.current.onSelect(undefined);
    });
    cy.on("dbltap", "node", (e) => {
      handlers.current.onActivate(nodeId(e));
    });
    cy.on("cxttap", "node", (e) => {
      const p = e.renderedPosition;
      handlers.current.onContextMenu(nodeId(e), p.x, p.y);
    });
    cy.on("mouseover", "node", (e) => {
      highlightNeighbors(cy, nodeId(e));
    });
    cy.on("mouseout", "node", () => {
      highlightNeighbors(cy, emphasized(handlers.current));
    });
    const stopTheme = onThemeChange(() => {
      cy.style(focusStylesheet(readCanvasTheme()));
    });
    cyRef.current = cy;
    return () => {
      stopTheme();
      cy.destroy();
    };
  }, []);

  useEffect(() => {
    const cy = cyRef.current;
    if (!cy) return;
    const elements = elementsOf(props.graph, props.layout, props.colors);
    const wanted = new Set(elements.map((e) => String(e.data.id)));
    const first = cy.elements().empty();
    cy.batch(() => {
      cy.elements()
        .filter((el) => !wanted.has(el.id()))
        .remove();
      for (const el of elements) {
        const existing = cy.$id(String(el.data.id));
        if (existing.nonempty()) {
          existing.data(el.data);
        } else if (el.group === "nodes") {
          // New files grow out of the center.
          cy.add({ ...el, position: { x: 0, y: 0 } });
        } else {
          cy.add(el);
        }
      }
    });
    const positions = Object.fromEntries(
      props.layout.nodes.map((n) => [n.id, { ...n.position }]),
    );
    if (first) {
      cy.nodes().positions((n) => positions[n.id()] ?? { x: 0, y: 0 });
      fitWithin(cy, MAX_FIT_ZOOM, false);
      setDrawn((n) => n + 1);
      return;
    }
    const run = cy.layout({
      name: "preset",
      positions,
      animate: true,
      animationDuration: ANIMATION_MS,
      fit: false,
    });
    run.one("layoutstop", () => {
      fitWithin(cy, MAX_FIT_ZOOM, true);
      setDrawn((n) => n + 1);
    });
    run.run();
  }, [props.graph, props.layout, props.colors]);

  useEffect(() => {
    const cy = cyRef.current;
    if (!cy || !props.active) return;
    cy.resize();
    fitWithin(cy, MAX_FIT_ZOOM, false);
  }, [props.active]);

  useEffect(() => {
    const cy = cyRef.current;
    if (!cy) return;
    cy.$(":selected").unselect();
    if (props.selected !== undefined) cy.$id(props.selected).select();
    highlightNeighbors(cy, emphasized(props));
  }, [props.selected, props.layout, drawn]);

  return (
    <div className="relative h-full w-full">
      <div
        ref={container}
        className="h-full w-full"
        data-testid="focus-canvas"
        data-draws={drawn}
        aria-hidden="true"
      />
      <ul className="sr-only" aria-label="Focus nodes">
        {props.layout.nodes.map((n) => (
          <li key={n.id}>
            <button
              type="button"
              data-focus-id={n.id}
              aria-pressed={props.selected === n.id}
              onClick={() => {
                props.onSelect(n.id);
              }}
            >
              {n.kind === "group"
                ? `Folder group ${n.label}, ${n.detail}`
                : `${n.id}${n.kind === "center" ? " (center)" : ` (${n.side})`}`}
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
