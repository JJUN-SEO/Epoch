import cytoscape, { type ElementDefinition } from "cytoscape";
import fcose from "cytoscape-fcose";
import type { LayoutRequest, LayoutResponse } from "./layout-protocol";

/*
 * Runs the fcose layout on a headless Cytoscape instance, off the UI thread
 * (CLAUDE.md "App UX basics": layout in a Web Worker), and posts back the
 * positions. Sizes come with the request because a worker cannot measure
 * labels.
 */

cytoscape.use(fcose);

self.onmessage = (event: MessageEvent<LayoutRequest>) => {
  const started = performance.now();
  const { id, nodes, edges } = event.data;
  const elements: ElementDefinition[] = [
    ...nodes.map((n) => ({
      group: "nodes" as const,
      data: {
        id: n.id,
        size: n.size,
        ...(n.parent === undefined ? {} : { parent: n.parent }),
      },
    })),
    ...edges.map((e) => ({ group: "edges" as const, data: { ...e } })),
  ];
  const cy = cytoscape({
    headless: true,
    styleEnabled: true,
    elements,
    style: [
      {
        selector: "node",
        style: { width: "data(size)", height: "data(size)" },
      },
      { selector: ":parent", style: { padding: "14px" } },
    ],
  });
  cy.layout({
    name: "fcose",
    animate: false,
    randomize: true,
    quality: "default",
    nodeDimensionsIncludeLabels: false,
    // Packing needs the layout-utilities extension; components spread instead.
    packComponents: false,
    idealEdgeLength: 70,
    nodeSeparation: 60,
  } as cytoscape.LayoutOptions).run();
  const positions: Record<string, { x: number; y: number }> = {};
  cy.nodes().forEach((n) => {
    if (!n.isParent()) positions[n.id()] = { ...n.position() };
  });
  cy.destroy();
  const response: LayoutResponse = {
    id,
    positions,
    ms: performance.now() - started,
  };
  self.postMessage(response);
};
