import cytoscape, { type ElementDefinition } from "cytoscape";
import fcose from "cytoscape-fcose";
import type { LayoutRequest, LayoutResponse } from "./layout-protocol";
import { packedLayout } from "./pack";
import { seedPositions } from "./seed";

/*
 * Runs the layout on a headless Cytoscape instance, off the UI thread
 * (CLAUDE.md "App UX basics": layout in a Web Worker), and posts back the
 * positions. Sizes come with the request because a worker cannot measure
 * labels. A large graph (pack.ts PACK_ABOVE_FILES; the view decides) is
 * packed, because fcose's time grows far faster than the graph (3.2 s at
 * 1,200 nodes, 67 s at 3,100 on vitest); otherwise fcose lays out every node.
 */

cytoscape.use(fcose);

interface Point {
  x: number;
  y: number;
}

interface LayoutNode {
  readonly id: string;
  readonly parent?: string;
  readonly width: number;
  readonly height: number;
}

/** fcose over `nodes`; refines from `start` when given. Returns leaf positions. */
function fcoseLayout(
  nodes: readonly LayoutNode[],
  edges: LayoutRequest["edges"],
  start: Readonly<Record<string, Point>> | undefined,
): Record<string, Point> {
  const elements: ElementDefinition[] = [
    ...nodes.map((n) => {
      const position = start?.[n.id];
      return {
        group: "nodes" as const,
        data: {
          id: n.id,
          width: n.width,
          height: n.height,
          ...(n.parent === undefined ? {} : { parent: n.parent }),
        },
        ...(position ? { position: { ...position } } : {}),
      };
    }),
    ...edges.map((e) => ({ group: "edges" as const, data: { ...e } })),
  ];
  const cy = cytoscape({
    headless: true,
    styleEnabled: true,
    elements,
    style: [
      {
        selector: "node",
        style: { width: "data(width)", height: "data(height)" },
      },
      { selector: ":parent", style: { padding: "14px" } },
    ],
  });
  cy.layout({
    name: "fcose",
    animate: false,
    randomize: start === undefined,
    quality: "default",
    nodeDimensionsIncludeLabels: false,
    // Packing needs the layout-utilities extension; components spread instead.
    packComponents: false,
    idealEdgeLength: 70,
    nodeSeparation: 60,
  } as cytoscape.LayoutOptions).run();
  const positions: Record<string, Point> = {};
  cy.nodes().forEach((n) => {
    if (!n.isParent()) positions[n.id()] = { ...n.position() };
  });
  cy.destroy();
  return positions;
}

self.onmessage = (event: MessageEvent<LayoutRequest>) => {
  const started = performance.now();
  const request = event.data;
  const layout = request.packed
    ? packedLayout(request)
    : {
        positions: fcoseLayout(
          request.nodes.map((n) => ({
            id: n.id,
            width: n.size,
            height: n.size,
            ...(n.parent === undefined ? {} : { parent: n.parent }),
          })),
          request.edges,
          // With previous positions, refine from them (fcose's incremental layout).
          seedPositions(request),
        ),
      };
  const response: LayoutResponse = {
    id: request.id,
    ...layout,
    ms: performance.now() - started,
  };
  self.postMessage(response);
};
