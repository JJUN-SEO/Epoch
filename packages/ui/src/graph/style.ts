import type { StylesheetJson } from "cytoscape";
import type { CanvasTheme } from "./theme";

/** Size in model units: files are small, collapsed directories grow with their file count. */
export function nodeSize(
  kind: string,
  collapsed: boolean,
  fileCount: number,
): number {
  if (kind !== "dir") return 14;
  if (!collapsed) return 14; // compound: sized by its children
  return Math.round(24 + 10 * Math.log2(1 + fileCount));
}

/** Classes shared by both canvases while a node is hovered or selected. */
const highlight = (t: CanvasTheme): StylesheetJson => [
  { selector: "node.faded:childless", style: { opacity: 0.14 } },
  {
    selector: "node.faded:parent",
    style: { "text-opacity": 0.35, "border-opacity": 0.35 },
  },
  { selector: "edge.faded", style: { opacity: 0.06 } },
  {
    selector: "node.hl",
    style: { "min-zoomed-font-size": 0, "z-index": 10, "font-weight": "bold" },
  },
  {
    selector: "edge.out",
    style: {
      "line-color": t.imports,
      "target-arrow-color": t.imports,
      opacity: 1,
      "z-index": 10,
    },
  },
  {
    selector: "edge.in",
    style: {
      "line-color": t.dependents,
      "target-arrow-color": t.dependents,
      opacity: 1,
      "z-index": 10,
    },
  },
  {
    selector: "node:selected",
    style: {
      "border-width": 3,
      "border-color": t.accent,
      "border-opacity": 1,
      "min-zoomed-font-size": 0,
    },
  },
];

/**
 * The full graph (CLAUDE.md principle 3): facts are solid edges, hints are
 * dashed. Collapsed directories are rounded squares labeled with their file
 * count; expanded ones are boxes around their contents. File labels appear
 * once zoomed in, or when highlighted.
 */
export function graphStylesheet(t: CanvasTheme): StylesheetJson {
  return [
    {
      selector: "node",
      style: {
        label: "data(label)",
        "font-size": 10,
        color: t.text,
        "text-valign": "bottom",
        "text-margin-y": 4,
        "min-zoomed-font-size": 9,
        "text-outline-color": t.canvas,
        "text-outline-width": 2,
        "text-outline-opacity": 0.85,
        width: "data(size)",
        height: "data(size)",
        "background-color": "data(color)",
        "border-width": 0,
      },
    },
    {
      selector: "node[kind = 'dir']",
      style: {
        shape: "round-rectangle",
        "background-color": "data(color)",
        "background-opacity": 0.22,
        "border-width": 1,
        "border-color": "data(color)",
        "text-valign": "center",
        "text-margin-y": 0,
        "font-size": 11,
        "min-zoomed-font-size": 4,
      },
    },
    {
      selector: ":parent",
      style: {
        "background-color": t.chrome,
        "background-opacity": 0.55,
        "border-color": t.faint,
        "border-opacity": 0.6,
        "text-valign": "top",
        "text-halign": "center",
        "text-margin-y": -6,
        "font-size": 12,
        "font-weight": "bold",
        "min-zoomed-font-size": 5,
        color: t.muted,
        padding: "16px",
        shape: "round-rectangle",
      },
    },
    {
      selector: "edge",
      style: {
        width: "data(width)",
        "line-color": t.edge,
        "target-arrow-color": t.edge,
        "target-arrow-shape": "triangle",
        "arrow-scale": 0.6,
        "curve-style": "bezier",
        opacity: 0.7,
      },
    },
    { selector: "edge[?hint]", style: { "line-style": "dashed" } },
    ...highlight(t),
  ];
}

/**
 * The focus view: the center file large, imports on the right with labels to
 * their right, dependents on the left with labels to their left. Edges are
 * colored by direction; edges between neighbors are faint.
 */
export function focusStylesheet(t: CanvasTheme): StylesheetJson {
  return [
    {
      selector: "node",
      style: {
        label: "data(label)",
        "font-size": 11,
        color: t.text,
        "text-wrap": "wrap",
        "text-max-width": "180px",
        "text-valign": "center",
        "line-height": 1.25,
        width: 12,
        height: 12,
        "background-color": "data(color)",
        "border-width": 0,
      },
    },
    {
      selector: "node[side = 'imports']",
      style: {
        "text-halign": "right",
        "text-justification": "left",
        "text-margin-x": 8,
      },
    },
    {
      selector: "node[side = 'dependents']",
      style: {
        "text-halign": "left",
        "text-justification": "right",
        "text-margin-x": -8,
      },
    },
    {
      selector: "node[kind = 'center']",
      style: {
        width: 28,
        height: 28,
        "font-size": 13,
        "font-weight": "bold",
        "text-valign": "bottom",
        "text-halign": "center",
        "text-justification": "center",
        "text-margin-y": 8,
        "border-width": 4,
        "border-color": t.accent,
        "border-opacity": 0.35,
      },
    },
    {
      selector: "node[kind = 'group']",
      style: {
        shape: "round-rectangle",
        width: 18,
        height: 18,
        "background-opacity": 0.25,
        "border-width": 1.5,
        "border-style": "dashed",
        "border-color": "data(color)",
        color: t.muted,
      },
    },
    {
      selector: "node[?cycle]",
      style: {
        "border-width": 2,
        "border-color": t.dependents,
      },
    },
    {
      selector: "edge",
      style: {
        width: "data(width)",
        // Bezier keeps the two edges of a cycle apart; single edges stay straight.
        "curve-style": "bezier",
        "target-arrow-shape": "triangle",
        "arrow-scale": 0.7,
        opacity: 0.85,
        "line-color": t.edge,
        "target-arrow-color": t.edge,
      },
    },
    {
      selector: "edge[dir = 'imports'][?outward]",
      style: { "line-color": t.imports, "target-arrow-color": t.imports },
    },
    {
      selector: "edge[dir = 'dependents'][?outward]",
      style: { "line-color": t.dependents, "target-arrow-color": t.dependents },
    },
    { selector: "edge[!outward]", style: { opacity: 0.3 } },
    { selector: "edge[?hint]", style: { "line-style": "dashed" } },
    ...highlight(t),
  ];
}
