import cytoscape, { type Core, type StylesheetJson } from "cytoscape";

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

/** A Cytoscape instance with Epoch's shared settings. */
export function createCy(container: HTMLElement, style: StylesheetJson): Core {
  preventStyleInjection();
  return cytoscape({
    container,
    style,
    minZoom: 0.05,
    maxZoom: 3,
    boxSelectionEnabled: false,
    autounselectify: false,
    // Smoother trackpad zoom than the default.
    wheelSensitivity: 0.3,
  });
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
    cy.elements().removeClass("faded hl out in");
    cy.nodes().removeData("impact");
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
 * their direction colors. For an open folder, its files count as one node.
 */
export function highlightNeighbors(cy: Core, id: string | undefined): void {
  cy.batch(() => {
    cy.elements().removeClass("faded hl out in");
    cy.nodes().removeData("impact");
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
    cy.elements().addClass("faded");
    keep.union(keep.ancestors()).removeClass("faded");
    keep.addClass("hl");
    out.removeClass("faded").addClass("out");
    into.removeClass("faded").addClass("in");
  });
}
