import type { StylesheetJson } from "cytoscape";

const LANGUAGE_COLORS: Readonly<Record<string, string>> = {
  typescript: "#3178c6",
  javascript: "#c9a400",
  python: "#3572a5",
  go: "#00add8",
};

export const languageColor = (language: string | undefined): string =>
  (language === undefined ? undefined : LANGUAGE_COLORS[language]) ?? "#8b8f98";

/** Size in model units: files are small, collapsed directories grow with their file count. */
export function nodeSize(
  kind: string,
  collapsed: boolean,
  fileCount: number,
): number {
  if (kind !== "dir") return 16;
  if (!collapsed) return 16; // compound: sized by its children
  return Math.round(24 + 10 * Math.log2(1 + fileCount));
}

/**
 * The graph's look (CLAUDE.md principle 3): facts are solid edges, hints are
 * dashed. Collapsed directories are rounded squares labeled with their file
 * count; expanded ones are boxes around their contents.
 */
export function stylesheet(dark: boolean): StylesheetJson {
  const text = dark ? "#d7dae0" : "#24292f";
  const muted = dark ? "#5c6370" : "#9aa1ab";
  const accent = dark ? "#f0a35e" : "#d9480f";
  return [
    {
      selector: "node",
      style: {
        label: "data(label)",
        "font-size": 9,
        color: text,
        "text-valign": "bottom",
        "text-margin-y": 3,
        "min-zoomed-font-size": 7,
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
        "background-color": dark ? "#3a3f4b" : "#dde3ea",
        "border-width": 1,
        "border-color": muted,
        "text-valign": "center",
        "font-size": 10,
      },
    },
    {
      selector: ":parent",
      style: {
        "background-opacity": dark ? 0.12 : 0.35,
        "text-valign": "top",
        "text-margin-y": -4,
        padding: "14px",
      },
    },
    {
      selector: "edge",
      style: {
        width: "data(width)",
        "line-color": muted,
        "target-arrow-color": muted,
        "target-arrow-shape": "triangle",
        "arrow-scale": 0.6,
        "curve-style": "bezier",
        opacity: 0.75,
      },
    },
    { selector: "edge[?hint]", style: { "line-style": "dashed" } },
    {
      selector: "node:selected",
      style: { "border-width": 3, "border-color": accent },
    },
  ];
}
