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
import type { VisibleGraph } from "./aggregate";
import type { NodeColors } from "./colors";
import {
  controlsFor,
  createCy,
  fitWithin,
  highlightImpact,
  highlightNeighbors,
  type CanvasControls,
} from "./cy";
import { LayoutClient } from "./layout";
import { graphStylesheet, nodeSize } from "./style";
import { onThemeChange, readCanvasTheme } from "./theme";

export interface GraphViewProps {
  /** Shown (the canvas resizes when it becomes visible again). */
  readonly active: boolean;
  readonly visible: VisibleGraph;
  readonly colors: NodeColors;
  readonly selected: string | undefined;
  /** Blast radius to draw: drawn node -> distance from the changed node. */
  readonly impact?: ReadonlyMap<string, number> | undefined;
  /** Center the view on this node once it is laid out (a new object re-centers). */
  readonly reveal: { readonly id: string } | undefined;
  readonly onSelect: (id: string | undefined) => void;
  /** Double-click: a folder opens or closes, a file opens in the focus view. */
  readonly onActivate: (id: string) => void;
  readonly onContextMenu: (id: string, x: number, y: number) => void;
  readonly controlsRef?: Ref<CanvasControls | undefined>;
}

const MAX_FIT_ZOOM = 1.5;

function elementsOf(
  visible: VisibleGraph,
  colors: NodeColors,
): ElementDefinition[] {
  return [
    ...visible.nodes.map((n) => ({
      group: "nodes" as const,
      data: {
        id: n.id,
        label:
          n.kind === "dir" && n.collapsed
            ? `${n.label} (${String(n.fileCount)})`
            : n.label,
        kind: n.kind,
        collapsed: n.collapsed,
        size: nodeSize(n.kind, n.collapsed, n.fileCount),
        color: colors.colorOf(
          n.kind === "dir" ? n.id.slice("dir:".length) : n.id,
          n.language,
        ),
        ...(n.parent === undefined ? {} : { parent: n.parent }),
      },
    })),
    ...visible.edges.map((e) => ({
      group: "edges" as const,
      data: {
        id: e.id,
        source: e.source,
        target: e.target,
        hint: e.hint,
        width: Math.min(4, 1 + Math.log2(e.count)),
      },
    })),
  ];
}

/**
 * The dependency graph, drawn by Cytoscape on a canvas. Layout runs in a Web
 * Worker. Hovering a node highlights its neighbors; the selection keeps its
 * highlight. A visually hidden list mirrors the nodes, so the graph can be
 * navigated by keyboard and screen readers (and driven by the e2e tests).
 */
export function GraphView(props: GraphViewProps) {
  const container = useRef<HTMLDivElement>(null);
  const cyRef = useRef<Core | undefined>(undefined);
  const layoutRef = useRef<LayoutClient | undefined>(undefined);
  const handlers = useRef(props);
  handlers.current = props;
  const needsFit = useRef(false);
  const [laidOut, setLaidOut] = useState(0);
  const [busy, setBusy] = useState(false);

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
    const cy = createCy(container.current, graphStylesheet(readCanvasTheme()));
    // Cytoscape types event targets as any; on a node selector it is a node.
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
    // While a blast radius is drawn, hovering leaves it alone.
    cy.on("mouseover", "node", (e) => {
      if (!handlers.current.impact) highlightNeighbors(cy, nodeId(e));
    });
    cy.on("mouseout", "node", () => {
      if (!handlers.current.impact) {
        highlightNeighbors(cy, handlers.current.selected);
      }
    });
    const stopTheme = onThemeChange(() => {
      cy.style(graphStylesheet(readCanvasTheme()));
    });
    cyRef.current = cy;
    layoutRef.current = new LayoutClient();
    return () => {
      stopTheme();
      layoutRef.current?.dispose();
      cy.destroy();
    };
  }, []);

  useEffect(() => {
    const cy = cyRef.current;
    const layout = layoutRef.current;
    if (!cy || !layout) return;
    const elements = elementsOf(props.visible, props.colors);
    let cancelled = false;
    setBusy(true);
    // Where the drawn nodes are now, so a changed graph or an opened folder
    // refines the current picture instead of starting over.
    const seed: Record<string, { x: number; y: number }> = {};
    cy.nodes().forEach((n) => {
      if (!n.isParent()) seed[n.id()] = { ...n.position() };
    });
    void layout
      .layout({
        ...(Object.keys(seed).length > 0 ? { seed } : {}),
        nodes: props.visible.nodes.map((n) => ({
          id: n.id,
          size: nodeSize(n.kind, n.collapsed, n.fileCount),
          ...(n.parent === undefined ? {} : { parent: n.parent }),
        })),
        edges: props.visible.edges.map((e) => ({
          id: e.id,
          source: e.source,
          target: e.target,
        })),
      })
      .then((result) => {
        if (cancelled || !result) return;
        cy.batch(() => {
          cy.elements().remove();
          cy.add(
            elements.map((el) => {
              const pos =
                typeof el.data.id === "string"
                  ? result.positions[el.data.id]
                  : undefined;
              return pos ? { ...el, position: { ...pos } } : el;
            }),
          );
        });
        // A hidden canvas has no size to fit to; fit once it is shown.
        if (handlers.current.active) fitWithin(cy, MAX_FIT_ZOOM, false);
        else needsFit.current = true;
        setBusy(false);
        setLaidOut((n) => n + 1);
      });
    return () => {
      cancelled = true;
    };
    // Colors restyle in place (below); only the visible graph needs a layout.
  }, [props.visible]);

  useEffect(() => {
    const cy = cyRef.current;
    if (!cy) return;
    const languages = new Map(
      props.visible.nodes.map((v) => [v.id, v.language]),
    );
    cy.batch(() => {
      cy.nodes().forEach((n) => {
        const id = n.id();
        const language = languages.get(id);
        n.data(
          "color",
          props.colors.colorOf(
            id.startsWith("dir:") ? id.slice("dir:".length) : id,
            language,
          ),
        );
      });
    });
    // Only a change of colors restyles; the layout effect sets them on redraw.
  }, [props.colors]);

  useEffect(() => {
    const cy = cyRef.current;
    if (!cy) return;
    cy.$(":selected").unselect();
    if (props.selected !== undefined) cy.$id(props.selected).select();
    if (props.impact) highlightImpact(cy, props.impact);
    else highlightNeighbors(cy, props.selected);
  }, [props.selected, props.impact, laidOut]);

  useEffect(() => {
    const cy = cyRef.current;
    if (!cy || !props.active) return;
    cy.resize();
    if (needsFit.current) {
      needsFit.current = false;
      fitWithin(cy, MAX_FIT_ZOOM, false);
    }
  }, [props.active]);

  useEffect(() => {
    const cy = cyRef.current;
    if (!cy || props.reveal === undefined || !props.active) return;
    const node = cy.$id(props.reveal.id);
    if (node.nonempty()) {
      cy.animate(
        { center: { eles: node }, zoom: Math.max(cy.zoom(), 1) },
        { duration: 200 },
      );
    }
  }, [props.reveal, props.active, laidOut]);

  return (
    <div className="relative h-full w-full">
      <div
        ref={container}
        className="h-full w-full"
        data-testid="graph-canvas"
        data-layouts={laidOut}
        aria-hidden="true"
      />
      {busy && (
        <div className="bg-raised text-muted shadow-pop pointer-events-none absolute top-3 left-1/2 -translate-x-1/2 rounded-full px-3 py-1 text-xs">
          Laying out…
        </div>
      )}
      <ul className="sr-only" aria-label="Graph nodes">
        {props.visible.nodes.map((n) => (
          <li key={n.id}>
            <button
              type="button"
              data-node-id={n.id}
              aria-pressed={props.selected === n.id}
              onClick={() => {
                props.onSelect(n.id);
              }}
            >
              {n.kind === "dir" ? `Folder ${n.id.slice(4)}` : n.id}
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
