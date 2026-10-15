import type { Graph } from "@epoch-dev/core";

/*
 * Node colors. By folder (the default: most repositories are one language,
 * so folders say more) or by language. Pure, for the tests.
 */

export type ColorBy = "folder" | "language";

const LANGUAGE_COLORS: Readonly<Record<string, string>> = {
  typescript: "#3178c6",
  javascript: "#d4b106",
  python: "#3572a5",
  go: "#00add8",
};

/** Distinct hues that read on light and dark canvases. */
const FOLDER_PALETTE = [
  "#5b7cfa",
  "#e0679d",
  "#22a88f",
  "#e39b2d",
  "#9b6cf0",
  "#3aa6d8",
  "#e0664a",
  "#72ad36",
  "#c56ad6",
  "#c9a227",
] as const;

const NEUTRAL = "#8b8f98";

export const languageColor = (language: string | undefined): string =>
  (language === undefined ? undefined : LANGUAGE_COLORS[language]) ?? NEUTRAL;

/** The top-level folder of a node id or a folder path ("" at the root). */
export function topFolder(id: string): string {
  if (id.startsWith("pkg:")) return id;
  const slash = id.indexOf("/");
  return slash === -1 ? "" : id.slice(0, slash);
}

export interface NodeColors {
  readonly by: ColorBy;
  /** Color for a graph node id, or for a folder path when `language` is undefined. */
  colorOf(id: string, language: string | undefined): string;
  /** Legend entries, in palette order. */
  readonly legend: readonly {
    readonly label: string;
    readonly color: string;
  }[];
}

export function nodeColors(graph: Graph, by: ColorBy): NodeColors {
  if (by === "language") {
    const languages = [...new Set(graph.nodes.map((n) => n.language))].sort();
    return {
      by,
      colorOf: (_id, language) => languageColor(language),
      legend: languages.map((l) => ({ label: l, color: languageColor(l) })),
    };
  }
  const folders = [
    ...new Set(graph.nodes.map((n) => topFolder(n.id)).filter((f) => f !== "")),
  ].sort();
  const palette = new Map(
    folders.map((f, i) => [
      f,
      FOLDER_PALETTE[i % FOLDER_PALETTE.length] ?? NEUTRAL,
    ]),
  );
  return {
    by,
    colorOf: (id) => palette.get(topFolder(id)) ?? NEUTRAL,
    legend: folders.map((f) => ({
      label: `${f}/`,
      color: palette.get(f) ?? NEUTRAL,
    })),
  };
}
