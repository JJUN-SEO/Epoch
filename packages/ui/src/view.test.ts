import { describe, expect, it } from "vitest";
import type { ProjectInfo } from "@epoch-dev/core";
import { graph as testGraph } from "./graph/test-graph";
import { initialView } from "./view";

describe("initialView", () => {
  it("starts on the welcome screen without a project", () => {
    expect(initialView()).toEqual({ kind: "start" });
  });

  it("opens straight onto a given project's graph (the static demo)", () => {
    const project: ProjectInfo = { root: "demo/zod", name: "zod" };
    const graph = testGraph(["a.ts"], []);
    expect(initialView({ project, graph })).toEqual({
      kind: "graph",
      project,
      graph,
    });
  });
});
