import type { Graph } from "@epoch-dev/core";

/*
 * Node colors. By folder (the default: most repositories are one language,
 * so folders say more), by language, or by risk score. Pure, for the tests.
 */

export type ColorBy = "folder" | "language" | "risk";

/** Risk bands, lowest first: upper bound (exclusive, except the last) and color. */
export const RISK_BANDS: readonly {
  readonly max: number;
  readonly label: string;
  readonly color: string;
}[] = [
  { max: 25, label: "Risk 0–25", color: "#3f9b6b" },
  { max: 50, label: "Risk 25–50", color: "#c9a227" },
  { max: 75, label: "Risk 50–75", color: "#e07b39" },
  { max: 100, label: "Risk 75–100", color: "#d64545" },
];

/** The band color for a risk score; neutral for a node with none. */
export function riskColor(score: number | undefined): string {
  if (score === undefined) return NEUTRAL;
  return (
    RISK_BANDS.find((b) => score < b.max)?.color ??
    RISK_BANDS[RISK_BANDS.length - 1]?.color ??
    NEUTRAL
  );
}

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
  if (by === "risk") {
    const scores = new Map(
      graph.nodes.map((n) => [n.id, n.metrics.riskScore] as const),
    );
    return {
      by,
      // Folders show the highest risk among their files.
      colorOf: (id, language) => {
        if (language !== undefined || scores.has(id)) {
          return riskColor(scores.get(id));
        }
        let max: number | undefined;
        for (const [nid, s] of scores) {
          if (s !== undefined && nid.startsWith(`${id}/`)) {
            max = Math.max(max ?? 0, s);
          }
        }
        return riskColor(max);
      },
      legend: [
        ...RISK_BANDS.map((b) => ({ label: b.label, color: b.color })),
        { label: "No score", color: NEUTRAL },
      ],
    };
  }
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
