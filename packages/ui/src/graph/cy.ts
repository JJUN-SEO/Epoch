import cytoscape, {
  type Collection,
  type Core,
  type StylesheetJson,
} from "cytoscape";

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

/**
 * The wheel's zoom factor for one event, after d3-zoom's curve: about 15%
 * per mouse-wheel notch (100 pixels), proportional for trackpads, and ten
 * times faster for a trackpad pinch (which arrives with ctrlKey). Cytoscape's
 * own wheel zoom moves a mouse notch by a fixed 2.8% (0.8% at the 0.3
 * sensitivity Epoch used), which "barely moves".
 */
export function wheelZoomFactor(e: {
  readonly deltaY: number;
  readonly deltaMode: number;
  readonly ctrlKey: boolean;
}): number {
  const perUnit = e.deltaMode === 1 ? 0.05 : e.deltaMode === 2 ? 1 : 0.002;
  return 2 ** (-e.deltaY * perUnit * (e.ctrlKey ? 10 : 1));
}

/** Wheel zoom toward the pointer, at most once per frame. */
function zoomOnWheel(cy: Core, container: HTMLElement): () => void {
  let factor = 1;
  let at = { x: 0, y: 0 };
  let frame = 0;
  const onWheel = (e: WheelEvent) => {
    e.preventDefault();
    const box = container.getBoundingClientRect();
    at = { x: e.clientX - box.left, y: e.clientY - box.top };
    factor *= wheelZoomFactor(e);
    if (frame !== 0) return;
    frame = requestAnimationFrame(() => {
      frame = 0;
      const level = Math.min(
        cy.maxZoom(),
        Math.max(cy.minZoom(), cy.zoom() * factor),
      );
      factor = 1;
      cy.zoom({ level, renderedPosition: at });
    });
  };
  container.addEventListener("wheel", onWheel, { passive: false });
  return () => {
    container.removeEventListener("wheel", onWheel);
    cancelAnimationFrame(frame);
  };
}

/** A Cytoscape instance with Epoch's shared settings. */
export function createCy(
  container: HTMLElement,
  style: StylesheetJson,
  mode: { readonly large: boolean } = { large: false },
): Core {
  preventStyleInjection();
  const cy = cytoscape({
    container,
    style,
    // A packed large graph is many screens wide; it must still fit.
    minZoom: mode.large ? 0.005 : 0.05,
    maxZoom: 3,
    boxSelectionEnabled: false,
    autounselectify: false,
    // The wheel zooms through zoomOnWheel; buttons and fit zoom in code.
    userZoomingEnabled: false,
    // A large graph pans as a cached picture, without its edges, and is
    // redrawn when it stops.
    ...(mode.large
      ? { textureOnViewport: true, hideEdgesOnViewport: true }
      : {}),
  });
  const stop = zoomOnWheel(cy, container);
  cy.one("destroy", stop);
  return cy;
}

/** Zoom and fit, for the canvas toolbar. */
export interface CanvasControls {
  zoomIn(): void;
  zoomOut(): void;
  fit(): void;
}

export function controlsFor(cy: Core, maxFitZoom: number): CanvasControls {
  const zoomBy = (factor: number) => {
    cy.animate(
      {
        zoom: {
          level: Math.min(
            cy.maxZoom(),
            Math.max(cy.minZoom(), cy.zoom() * factor),
          ),
          renderedPosition: { x: cy.width() / 2, y: cy.height() / 2 },
        },
      },
      { duration: 150 },
    );
  };
  return {
    zoomIn: () => {
      zoomBy(1.4);
    },
    zoomOut: () => {
      zoomBy(1 / 1.4);
    },
    fit: () => {
      fitWithin(cy, maxFitZoom, true);
    },
  };
}

/** Pans so the nodes themselves (not their labels) sit in the middle. */
function centerNodes(cy: Core): void {
  const bb = cy.elements().boundingBox({ includeLabels: false });
  const zoom = cy.zoom();
  cy.pan({
    x: cy.width() / 2 - (zoom * (bb.x1 + bb.x2)) / 2,
    y: cy.height() / 2 - (zoom * (bb.y1 + bb.y2)) / 2,
  });
}

/** Fits everything, without zooming in past `maxZoom` (a few nodes would fill the screen). */
export function fitWithin(cy: Core, maxZoom: number, animate: boolean): void {
  if (cy.elements().empty()) return;
  const before = { zoom: cy.zoom(), pan: { ...cy.pan() } };
  cy.fit(undefined, 48);
  if (cy.zoom() > maxZoom) {
    cy.zoom(maxZoom);
    centerNodes(cy);
  }
  if (!animate) return;
  const after = { zoom: cy.zoom(), pan: { ...cy.pan() } };
  cy.zoom(before.zoom);
  cy.pan(before.pan);
  cy.animate({ zoom: after.zoom, pan: after.pan }, { duration: 250 });
}

/** Canvases whose every element carries highlight classes (a fade over everything). */
const styledAll = new WeakSet<Core>();
/** What the last highlight without fading marked. */
const marked = new WeakMap<Core, Collection>();

function clearHighlight(cy: Core): void {
  if (styledAll.has(cy)) {
    cy.elements().removeClass("faded hl center out in");
    cy.nodes().removeData("impact");
    styledAll.delete(cy);
  }
  marked.get(cy)?.removeClass("faded hl center out in");
  marked.delete(cy);
}

/**
 * Blast radius on the canvas: fades everything except the changed node
 * (depth 0) and what depends on it, each marked with its distance (capped at
 * 3 for styling), and the edges among them.
 */
export function highlightImpact(
  cy: Core,
  depths: ReadonlyMap<string, number>,
): void {
  cy.batch(() => {
    clearHighlight(cy);
    styledAll.add(cy);
    cy.elements().addClass("faded");
    let kept = cy.collection();
    for (const [id, depth] of depths) {
      const node = cy.$id(id);
      if (node.empty()) continue;
      node.data("impact", Math.min(depth, 3));
      kept = kept.union(node);
    }
    kept.union(kept.ancestors()).removeClass("faded");
    kept.edgesWith(kept).removeClass("faded").addClass("in");
  });
}

/**
 * Fades everything except `id`, its direct neighbors and the edges between
 * them; outgoing edges (its imports) and incoming ones (its dependents) get
 * their direction colors, and the node itself is marked `center`. For an
 * open folder, its files count as one node.
 * With `fade: false` (a large graph, where restyling every element on each
 * hover stalls the page) only the neighborhood is marked.
 */
export function highlightNeighbors(
  cy: Core,
  id: string | undefined,
  opts: { readonly fade?: boolean } = {},
): void {
  cy.batch(() => {
    clearHighlight(cy);
    if (id === undefined) return;
    const node = cy.$id(id);
    if (node.empty()) return;
    const members = node.union(node.descendants());
    const out = members
      .outgoers()
      .edges()
      .filter((e) => !members.has(e.target()));
    const into = members
      .incomers()
      .edges()
      .filter((e) => !members.has(e.source()));
    const keep = members.union(out.targets()).union(into.sources());
    if (opts.fade ?? true) {
      styledAll.add(cy);
      cy.elements().addClass("faded");
      keep.union(keep.ancestors()).removeClass("faded");
    } else {
      marked.set(cy, keep.union(out).union(into));
    }
    keep.addClass("hl");
    node.addClass("center");
    out.removeClass("faded").addClass("out");
    into.removeClass("faded").addClass("in");
  });
}
