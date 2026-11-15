import {
  dependencyPath,
  type DependencyPath,
  type Graph,
} from "@epoch-dev/core";

/*
 * "Path to another file" in the details panel (ADR-021): how the selected
 * file and another are connected, from core's dependencyPath. Pure, for the
 * tests and the static demo.
 */

export type Connection =
  /** The selected file depends on the other. */
  | { readonly kind: "forward"; readonly path: DependencyPath }
  /** The other depends on the selected file. */
  | { readonly kind: "reverse"; readonly path: DependencyPath }
  | { readonly kind: "none" };

/**
 * How `from` and `to` are connected, in either direction. A chain of proven
 * imports is preferred; a chain that needs likely relations (hints at or
 * above `hintThreshold`) is given only when there is none.
 */
export function connect(
  graph: Graph,
  from: string,
  to: string,
  hintThreshold: number,
): Connection {
  const opts = {
    mode: "likely",
    includeTypeOnly: true,
    hintThreshold,
  } as const;
  const forward = dependencyPath(graph, from, to, opts);
  if (forward) return { kind: "forward", path: forward };
  const reverse = dependencyPath(graph, to, from, opts);
  return reverse ? { kind: "reverse", path: reverse } : { kind: "none" };
}

const imports = (n: number) => `${String(n)} ${n === 1 ? "import" : "imports"}`;

/** One sentence for a connection, from the selected file's side. */
export function connectionSentence(c: Connection): string {
  if (c.kind === "none") return "Neither file depends on the other.";
  const hops = c.path.hops.length;
  const hints = c.path.viaHints;
  const likely =
    hints === 0
      ? ""
      : ` ${hints === hops ? (hops === 1 ? "It is" : "All are") : `${String(hints)} of them ${hints === 1 ? "is" : "are"}`} ${hints === 1 ? "a likely relation" : "likely relations"}, not ${hints === 1 ? "a proven import" : "proven imports"}.`;
  return c.kind === "forward"
    ? `This file depends on it through ${imports(hops)}.${likely}`
    : `This file does not depend on it. It depends on this file through ${imports(hops)}.${likely}`;
}
