import type { Graph, ProjectInfo } from "@epoch-dev/core";

/** Where the app is: welcome, analyzing a project, or showing its graph. */
export type View =
  | { readonly kind: "start"; readonly error?: string }
  | { readonly kind: "analyzing"; readonly project: ProjectInfo }
  | {
      readonly kind: "graph";
      readonly project: ProjectInfo;
      readonly graph: Graph;
    };

/** A project and graph the app opens on, as the static demo does. */
export interface InitialProject {
  readonly project: ProjectInfo;
  readonly graph: Graph;
}

/** The first view: the given project's graph, or the welcome screen. */
export function initialView(initial?: InitialProject): View {
  return initial
    ? { kind: "graph", project: initial.project, graph: initial.graph }
    : { kind: "start" };
}
