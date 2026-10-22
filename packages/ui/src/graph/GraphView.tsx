import type {
  Core,
  EdgeSingular,
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
import type { Confidence } from "@epoch-dev/core";
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
import { LayoutCache, layoutKey } from "./layout-cache";
import type { LayoutRequest, LayoutResponse } from "./layout-protocol";
import { isLargeGraph } from "./pack";
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
  /** Drawn node -> highest confidence of the open findings it holds. */
  readonly findingRings?: ReadonlyMap<string, Confidence> | undefined;
  /** Fade nodes without open findings. */
  readonly findingsOnly?: boolean | undefined;
  /** Center the view on this node once it is laid out (a new object re-centers). */
  readonly reveal: { readonly id: string } | undefined;
  readonly onSelect: (id: string | undefined) => void;
  /** Double-click: a folder opens or closes, a file opens in the focus view. */
  readonly onActivate: (id: string) => void;
  readonly onContextMenu: (id: string, x: number, y: number) => void;
  readonly controlsRef?: Ref<CanvasControls | undefined>;
}

const MAX_FIT_ZOOM = 1.5;
/** How long the pointer rests on a file of a large graph before it is highlighted. */
const HOVER_DELAY_MS = 100;
/**
 * A large graph with more edges than this draws, zoomed out below FAR_ZOOM,
 * only the edges around what is highlighted: thousands of faint lines read
 * as haze there and made every redraw slow. Zooming in shows them all.
 */
const FAR_EDGES_ABOVE = 2000;
const FAR_ZOOM = 0.25;

/**
 * Cytoscape elements for the visible graph, placed where the layout put them.
 * Open folders are compound parents, or, given frames (a large graph), plain
 * rectangles behind their files with no compound relation at all.
 */
function elementsOf(
  visible: VisibleGraph,
  colors: NodeColors,
  layout: LayoutResponse,
): ElementDefinition[] {
  const frames = layout.frames;
  return [
    ...visible.nodes.map((n) => {
      const frame = frames?.[n.id];
      const position = frame ?? layout.positions[n.id];
      return {
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
          ...(frame
            ? {
                frame: true,
                width: frame.width,
                height: frame.height,
                labelSize: frame.labelSize,
              }
            : {}),
          ...(n.parent === undefined || frames ? {} : { parent: n.parent }),
        },
        ...(position ? { position: { x: position.x, y: position.y } } : {}),
      };
    }),
    ...visible.edges.map((e) => ({
      group: "edges" as const,
      data: {
        id: e.id,
        source: e.source,
        target: e.target,
        hint: e.hint,
        detail: e.detail ?? "",
        width: Math.min(4, 1 + Math.log2(e.count)),
      },
    })),
  ];
}

/** Updates what can change without moving anything: labels, folder state, edge data. */
function updateData(cy: Core, visible: VisibleGraph): void {
  for (const n of visible.nodes) {
    cy.$id(n.id).data({
      label:
        n.kind === "dir" && n.collapsed
          ? `${n.label} (${String(n.fileCount)})`
          : n.label,
      collapsed: n.collapsed,
    });
  }
  for (const e of visible.edges) {
    cy.$id(e.id).data({
      hint: e.hint,
      detail: e.detail ?? "",
      width: Math.min(4, 1 + Math.log2(e.count)),
    });
  }
}

/**
 * The dependency graph, drawn by Cytoscape on a canvas. Layout runs in a Web
 * Worker. Hovering a node highlights its neighbors; the selection keeps its
 * highlight. A large graph (pack.ts) is packed, its open folders drawn as
 * plain rectangles, on a canvas in large-graph mode (cy.ts), made anew when
 * the graph crosses the line. Recent layouts are kept by what they laid out
 * (layout-cache.ts): an unchanged structure keeps its picture, and folders
 * shown before come back where they were. A visually hidden list mirrors the
 * nodes, so the graph can be navigated by keyboard and screen readers (and
 * driven by the e2e tests).
 */
export function GraphView(props: GraphViewProps) {
  const container = useRef<HTMLDivElement>(null);
  const cyRef = useRef<Core | undefined>(undefined);
  const layoutRef = useRef<LayoutClient | undefined>(undefined);
  const cacheRef = useRef(new LayoutCache());
  /** The layout key of what the canvas shows. */
  const drawnKey = useRef<string | undefined>(undefined);
  const handlers = useRef(props);
  handlers.current = props;
  const needsFit = useRef(false);
  const [laidOut, setLaidOut] = useState(0);
  /** How many nodes the last finished layout drew (for the e2e tests). */
  const [drawn, setDrawn] = useState(0);
  const large = isLargeGraph(props.visible);
  const [busy, setBusy] = useState(false);
  /** The hovered hint edge's evidence, as text, where the pointer is. */
  const [edgeTip, setEdgeTip] = useState<
    { x: number; y: number; text: string } | undefined
  >();

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
    layoutRef.current = new LayoutClient();
    return () => {
      layoutRef.current?.dispose();
    };
  }, []);

  useEffect(() => {
    if (!container.current) return;
    const cy = createCy(
      container.current,
      graphStylesheet(readCanvasTheme(), { large }),
      { large },
    );
    const fade = !large;
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
    // In a large graph the pointer is nearly always over an open folder's
    // box; highlighting a whole subtree on every move stalls the page, so
    // only files and closed folders react to hovering there, and only once
    // the pointer rests on one: sweeping across thousands of them does not
    // redraw the canvas for each.
    const hoverable = large ? "node[!frame]" : "node";
    let hoverTimer = 0;
    const hover = (id: string | undefined) => {
      window.clearTimeout(hoverTimer);
      const apply = () => {
        if (!handlers.current.impact) {
          highlightNeighbors(cy, id ?? handlers.current.selected, { fade });
        }
      };
      if (large) hoverTimer = window.setTimeout(apply, HOVER_DELAY_MS);
      else apply();
    };
    cy.on("mouseover", hoverable, (e) => {
      hover(nodeId(e));
    });
    cy.on("mouseout", hoverable, () => {
      hover(undefined);
    });
    cy.on("mouseover", "edge", (e) => {
      const detail: unknown = (e.target as EdgeSingular).data("detail");
      if (typeof detail !== "string" || detail === "") return;
      const p = e.renderedPosition;
      setEdgeTip({ x: p.x, y: p.y, text: detail });
    });
    cy.on("mouseout", "edge", () => {
      setEdgeTip(undefined);
    });
    const stopTheme = onThemeChange(() => {
      cy.style(graphStylesheet(readCanvasTheme(), { large }));
    });
    cyRef.current = cy;
    drawnKey.current = undefined;
    return () => {
      window.clearTimeout(hoverTimer);
      stopTheme();
      cy.destroy();
      if (cyRef.current === cy) cyRef.current = undefined;
    };
  }, [large]);

  useEffect(() => {
    const cy = cyRef.current;
    const layout = layoutRef.current;
    if (!cy || !layout) return;
    const request: Omit<LayoutRequest, "id" | "seed"> = {
      ...(large ? { packed: true } : {}),
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
    };
    const key = layoutKey(request);
    // The same structure as drawn (a saved file whose imports did not
    // change, a folder shown that was already open): nothing moves.
    if (key === drawnKey.current) {
      cy.batch(() => {
        updateData(cy, props.visible);
      });
      // A layout asked for in between (and now cancelled) is not coming.
      setBusy(false);
      return;
    }
    const draw = (result: LayoutResponse) => {
      setEdgeTip(undefined);
      cy.batch(() => {
        cy.elements().remove();
        cy.add(elementsOf(props.visible, props.colors, result));
      });
      drawnKey.current = key;
      // A hidden canvas has no size to fit to; fit once it is shown.
      if (handlers.current.active) fitWithin(cy, MAX_FIT_ZOOM, false);
      else needsFit.current = true;
      setBusy(false);
      setDrawn(props.visible.nodes.length);
      setLaidOut((n) => n + 1);
    };
    const cached = cacheRef.current.get(key);
    if (cached) {
      draw(cached);
      return;
    }
    let cancelled = false;
    setBusy(true);
    // Where the drawn nodes are now, so a changed graph or an opened folder
    // refines the current picture instead of starting over (a packed layout
    // needs none: it is the same for the same folders).
    const seed: Record<string, { x: number; y: number }> = {};
    if (!large) {
      cy.nodes().forEach((n) => {
        if (!n.isParent()) seed[n.id()] = { ...n.position() };
      });
    }
    void layout
      .layout({
        ...request,
        ...(Object.keys(seed).length > 0 ? { seed } : {}),
      })
      .then((result) => {
        if (!result) return;
        cacheRef.current.set(key, result);
        if (!cancelled) draw(result);
      });
    return () => {
      cancelled = true;
    };
    // Colors restyle in place (below); only the visible graph needs a layout.
  }, [props.visible, large]);

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
    else highlightNeighbors(cy, props.selected, { fade: !large });
    const rings = props.findingRings;
    cy.batch(() => {
      cy.nodes().removeData("finding");
      for (const [id, level] of rings ?? []) cy.$id(id).data("finding", level);
      if (props.findingsOnly && !props.impact && props.selected === undefined) {
        cy.nodes(":childless")
          .filter(
            (n) => n.data("frame") !== true && rings?.has(n.id()) !== true,
          )
          .addClass("faded");
        cy.edges().addClass("faded");
      }
    });
  }, [
    props.selected,
    props.impact,
    props.findingRings,
    props.findingsOnly,
    laidOut,
    large,
  ]);

  useEffect(() => {
    const cy = cyRef.current;
    if (!cy) return;
    if (!large || cy.edges().length <= FAR_EDGES_ABOVE) {
      cy.edges().removeClass("far");
      return;
    }
    let far: boolean | undefined;
    const update = () => {
      const now = cy.zoom() < FAR_ZOOM;
      if (now === far) return;
      far = now;
      cy.batch(() => {
        if (now) cy.edges().addClass("far");
        else cy.edges().removeClass("far");
      });
    };
    update();
    cy.on("zoom", update);
    return () => {
      cy.off("zoom", update);
    };
  }, [laidOut, large]);

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
        data-drawn={drawn}
        data-large={large}
        data-hint-edges={props.visible.edges.filter((e) => e.hint).length}
        aria-hidden="true"
      />
      {edgeTip && (
        <div
          role="tooltip"
          data-testid="edge-tip"
          className="bg-raised border-line shadow-pop pointer-events-none absolute max-w-80 rounded-md border px-2 py-1 text-xs"
          style={{ left: edgeTip.x + 12, top: edgeTip.y + 12 }}
        >
          {edgeTip.text}
        </div>
      )}
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
