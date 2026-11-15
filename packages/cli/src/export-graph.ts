import {
  CERTAIN_EDGE_KINDS,
  HINT_DEFAULTS,
  isHintEdge,
  nodeFolder,
  type Graph,
  type GraphEdge,
  type GraphNode,
} from "@epoch-dev/core";

/*
 * `epoch export`: the graph in formats other tools read (ADR-021). Fact
 * edges of the displayed kinds; hint edges only when asked for, marked as
 * such. Node ids and evidence come from the analyzed repository, so every
 * one is escaped for the format it is written into.
 */

export const EXPORT_FORMATS = ["graphml", "mermaid", "dot"] as const;
export type ExportFormat = (typeof EXPORT_FORMATS)[number];

export interface ExportOptions {
  /** Only nodes in this folder (repository-relative) and the edges among them. */
  readonly scope?: string;
  /** Also export hint edges at or above the default threshold. */
  readonly likely?: boolean;
}

interface Selection {
  readonly nodes: readonly GraphNode[];
  readonly edges: readonly GraphEdge[];
}

function select(graph: Graph, opts: ExportOptions): Selection {
  const scope = opts.scope?.replaceAll("\\", "/").replace(/\/+$/, "");
  const inScope = (n: GraphNode): boolean => {
    if (scope === undefined || scope === "" || scope === ".") return true;
    const at = n.kind === "package" ? nodeFolder(n.id, graph) : n.id;
    return at === scope || at.startsWith(`${scope}/`);
  };
  const nodes = graph.nodes.filter(inScope);
  const ids = new Set(nodes.map((n) => n.id));
  const edges = graph.edges.filter(
    (e) =>
      e.source !== e.target &&
      ids.has(e.source) &&
      ids.has(e.target) &&
      (isHintEdge(e)
        ? opts.likely === true && e.confidence >= HINT_DEFAULTS.threshold
        : CERTAIN_EDGE_KINDS.has(e.kind)),
  );
  return { nodes, edges };
}

const xml = (s: string): string =>
  s
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    // Control characters XML 1.0 cannot carry.
    // eslint-disable-next-line no-control-regex -- stripping them is the point
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "");

/** GraphML (http://graphml.graphdrawing.org/primer/graphml-primer.html). */
function graphml({ nodes, edges }: Selection): string {
  const data = (key: string, value: string | number | undefined) =>
    value === undefined
      ? ""
      : `<data key="${key}">${xml(String(value))}</data>`;
  const lines = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<graphml xmlns="http://graphml.graphdrawing.org/xmlns">',
    '  <key id="kind" for="node" attr.name="kind" attr.type="string"/>',
    '  <key id="language" for="node" attr.name="language" attr.type="string"/>',
    '  <key id="lines" for="node" attr.name="lines" attr.type="int"/>',
    '  <key id="dependents" for="node" attr.name="dependents" attr.type="int"/>',
    '  <key id="risk" for="node" attr.name="risk" attr.type="string"/>',
    '  <key id="edgeKind" for="edge" attr.name="kind" attr.type="string"/>',
    '  <key id="confidence" for="edge" attr.name="confidence" attr.type="double"/>',
    '  <graph id="epoch" edgedefault="directed">',
    ...nodes.map(
      (n) =>
        `    <node id="${xml(n.id)}">${data("kind", n.kind)}${data("language", n.language)}${data("lines", n.loc)}${data("dependents", n.metrics.dependents)}${data("risk", n.metrics.risk?.tier)}</node>`,
    ),
    ...edges.map(
      (e) =>
        `    <edge source="${xml(e.source)}" target="${xml(e.target)}">${data("edgeKind", e.kind)}${data("confidence", e.confidence)}</edge>`,
    ),
    "  </graph>",
    "</graphml>",
    "",
  ];
  return lines.join("\n");
}

/** A DOT quoted string: only `"` and `\` need escaping; newlines are dropped. */
const dotString = (s: string): string =>
  `"${s
    .replaceAll("\\", "\\\\")
    .replaceAll('"', '\\"')
    .replace(/[\r\n]+/g, " ")}"`;

/** Graphviz DOT (https://graphviz.org/doc/info/lang.html). */
function dot({ nodes, edges }: Selection): string {
  return [
    "digraph epoch {",
    "  node [shape=box];",
    ...nodes.map((n) => `  ${dotString(n.id)};`),
    ...edges.map((e) => {
      const attrs = isHintEdge(e)
        ? ` [style=dashed, label=${dotString(`${e.kind} ${e.confidence.toFixed(2)}`)}]`
        : e.kind === "import"
          ? ""
          : ` [label=${dotString(e.kind)}]`;
      return `  ${dotString(e.source)} -> ${dotString(e.target)}${attrs};`;
    }),
    "}",
    "",
  ].join("\n");
}

/** A Mermaid label: quoted, with the characters Mermaid reads as syntax as entities. */
const mermaidLabel = (s: string): string =>
  `"${s
    .replaceAll("&", "#amp;")
    .replaceAll('"', "#quot;")
    .replaceAll("<", "#lt;")
    .replaceAll(">", "#gt;")
    .replace(/[\r\n]+/g, " ")}"`;

/** A Mermaid flowchart (https://mermaid.js.org/syntax/flowchart.html). */
function mermaid({ nodes, edges }: Selection): string {
  const name = new Map(nodes.map((n, i) => [n.id, `n${String(i)}`]));
  return [
    "flowchart LR",
    ...nodes.map((n) => `  ${name.get(n.id) ?? ""}[${mermaidLabel(n.id)}]`),
    ...edges.map((e) => {
      const arrow = isHintEdge(e)
        ? `-. ${mermaidLabel(`${e.kind} ${e.confidence.toFixed(2)}`)} .->`
        : e.kind === "import"
          ? "-->"
          : `-- ${mermaidLabel(e.kind)} -->`;
      return `  ${name.get(e.source) ?? ""} ${arrow} ${name.get(e.target) ?? ""}`;
    }),
    "",
  ].join("\n");
}

/** The graph, or the part of it under `scope`, as text in `format`. */
export function exportGraph(
  graph: Graph,
  format: ExportFormat,
  opts: ExportOptions = {},
): string {
  const selection = select(graph, opts);
  return format === "graphml"
    ? graphml(selection)
    : format === "dot"
      ? dot(selection)
      : mermaid(selection);
}
