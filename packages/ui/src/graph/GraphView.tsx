import cytoscape, {
  type Core,
  type ElementDefinition,
  type EventObject,
} from "cytoscape";
import { useEffect, useRef, useState } from "react";
import type { VisibleGraph } from "./aggregate";
import { LayoutClient } from "./layout";
import { languageColor, nodeSize, stylesheet } from "./style";

export interface GraphViewProps {
  readonly visible: VisibleGraph;
  readonly selected: string | undefined;
  /** Center the view on this node once it is laid out (a new object re-centers). */
  readonly focus: { readonly id: string } | undefined;
  readonly onSelect: (id: string | undefined) => void;
  readonly onToggleDir: (id: string) => void;
}

const MAX_FIT_ZOOM = 1.5;

const darkQuery = () => window.matchMedia("(prefers-color-scheme: dark)");

/**
 * Cytoscape injects a <style> element (giving its container position:
 * relative) unless one with this id exists. The strict CSP blocks injected
 * styles, so a marker stands in and styles.css carries the rule.
 */
function preventStyleInjection(): void {
  const id = "__________cytoscape_stylesheet";
  if (document.getElementById(id) === null) {
    const marker = document.createElement("meta");
    marker.id = id;
    document.head.append(marker);
  }
}

function elementsOf(visible: VisibleGraph): ElementDefinition[] {
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
        color: languageColor(n.language),
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
 * Worker. A visually hidden list mirrors the nodes, so the graph can be
 * navigated by keyboard and screen readers (and driven by the e2e tests).
 */
export function GraphView(props: GraphViewProps) {
  const container = useRef<HTMLDivElement>(null);
  const cyRef = useRef<Core | undefined>(undefined);
  const layoutRef = useRef<LayoutClient | undefined>(undefined);
  const handlers = useRef(props);
  handlers.current = props;
  const [laidOut, setLaidOut] = useState(0);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!container.current) return;
    preventStyleInjection();
    const cy = cytoscape({
      container: container.current,
      style: stylesheet(darkQuery().matches),
      minZoom: 0.05,
      maxZoom: 3,
      boxSelectionEnabled: false,
      autounselectify: false,
    });
    // Cytoscape types event targets as any; on a node selector it is a node.
    const nodeId = (e: EventObject) =>
      (e.target as cytoscape.NodeSingular).id();
    cy.on("tap", "node", (e) => {
      handlers.current.onSelect(nodeId(e));
    });
    cy.on("tap", (e) => {
      if (e.target === cy) handlers.current.onSelect(undefined);
    });
    cy.on("dbltap", "node[kind = 'dir']", (e) => {
      handlers.current.onToggleDir(nodeId(e));
    });
    const media = darkQuery();
    const onTheme = () => cy.style(stylesheet(media.matches));
    media.addEventListener("change", onTheme);
    cyRef.current = cy;
    layoutRef.current = new LayoutClient();
    return () => {
      media.removeEventListener("change", onTheme);
      layoutRef.current?.dispose();
      cy.destroy();
    };
  }, []);

  useEffect(() => {
    const cy = cyRef.current;
    const layout = layoutRef.current;
    if (!cy || !layout) return;
    const elements = elementsOf(props.visible);
    let cancelled = false;
    setBusy(true);
    void layout
      .layout({
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
        cy.fit(undefined, 40);
        // A few nodes would otherwise fill the screen.
        if (cy.zoom() > MAX_FIT_ZOOM) {
          cy.zoom(MAX_FIT_ZOOM);
          cy.center();
        }
        setBusy(false);
        setLaidOut((n) => n + 1);
      });
    return () => {
      cancelled = true;
    };
  }, [props.visible]);

  useEffect(() => {
    const cy = cyRef.current;
    if (!cy) return;
    cy.$(":selected").unselect();
    if (props.selected !== undefined) cy.$id(props.selected).select();
  }, [props.selected, laidOut]);

  useEffect(() => {
    const cy = cyRef.current;
    if (!cy || props.focus === undefined) return;
    const node = cy.$id(props.focus.id);
    if (node.nonempty()) {
      cy.animate(
        { center: { eles: node }, zoom: Math.max(cy.zoom(), 1) },
        { duration: 200 },
      );
    }
  }, [props.focus, laidOut]);

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
        <div className="pointer-events-none absolute top-3 left-3 rounded bg-neutral-900/70 px-2 py-1 text-xs text-white">
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
