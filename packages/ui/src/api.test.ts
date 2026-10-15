import { describe, expect, it, vi } from "vitest";
import type { Graph, GraphDelta, ProjectInfo } from "@epoch-dev/core";
import { createIpcApi, createStaticApi } from "./api";
import type { DesktopBridge } from "./bridge";
import { edge, graph as testGraph, node } from "./graph/test-graph";

const project: ProjectInfo = { root: "/p", name: "p" };
const graph: Graph = testGraph(["a.ts", "b.ts"], [edge("a.ts", "b.ts")]);

const openProject = vi.fn(() => Promise.resolve(project));
const showAppMenu = vi.fn(() => Promise.resolve());

function fakeBridge() {
  const deltaListeners: ((d: GraphDelta) => void)[] = [];
  const getGraph = vi.fn(() => Promise.resolve(graph));
  const bridge: DesktopBridge = {
    openProject,
    getGraph,
    onProgress: vi.fn(() => () => undefined),
    onGraphDelta: (cb) => {
      deltaListeners.push(cb);
      return () => undefined;
    },
    onWatchStatus: vi.fn(() => () => undefined),
    getAnalysisInfo: vi.fn(() => Promise.resolve(null)),
    onAnalysisInfo: vi.fn(() => () => undefined),
    chooseProject: vi.fn(() => Promise.resolve(null)),
    openDroppedFolder: vi.fn(() => Promise.resolve(project)),
    recentProjects: vi.fn(() => Promise.resolve(["/p"])),
    onProjectOpened: vi.fn(() => () => undefined),
    showAppMenu: showAppMenu,
    onMenuCommand: vi.fn(() => () => undefined),
  };
  return {
    bridge,
    getGraph,
    emitDelta: (d: GraphDelta) => {
      for (const l of deltaListeners) l(d);
    },
  };
}

describe("createIpcApi", () => {
  it("forwards the app's methods to the bridge", async () => {
    const { bridge } = fakeBridge();
    const { api, shell } = createIpcApi(bridge);
    await expect(api.openProject("/p")).resolves.toBe(project);
    expect(openProject).toHaveBeenCalledWith("/p");
    await expect(api.getGraph()).resolves.toBe(graph);
    await expect(shell.recentProjects()).resolves.toEqual(["/p"]);
    await expect(shell.chooseProject()).resolves.toBeNull();
    await expect(shell.getAnalysisInfo()).resolves.toBeNull();
    shell.showAppMenu(10, 40);
    expect(showAppMenu).toHaveBeenCalledWith(10, 40);
  });

  it("computes blast radius locally over the graph, kept current by deltas", async () => {
    const { bridge, getGraph, emitDelta } = fakeBridge();
    const { api } = createIpcApi(bridge);
    const opts = { mode: "certain", includeTypeOnly: true } as const;
    expect((await api.getBlastRadius("b.ts", opts)).total).toBe(1);
    emitDelta({
      upsertNodes: [node("c.ts")],
      removeNodes: [],
      upsertEdges: [edge("c.ts", "b.ts")],
      removeEdges: [],
    });
    const r = await api.getBlastRadius("b.ts", opts);
    expect(r.affected.map((a) => a.id)).toEqual(["a.ts", "c.ts"]);
    expect(getGraph).toHaveBeenCalledTimes(1);
  });

  it("rejects methods of later milestones, naming the milestone", async () => {
    const { api } = createIpcApi(fakeBridge().bridge);
    await expect(api.getFindings()).rejects.toThrow("M5");
    await expect(api.getSettings()).rejects.toThrow("M7");
  });
});

describe("createStaticApi", () => {
  it("serves one precomputed graph and nothing that needs a machine", async () => {
    const api = createStaticApi(project, graph);
    await expect(api.openProject("/anything")).resolves.toBe(project);
    await expect(api.getGraph()).resolves.toBe(graph);
    await expect(
      api.getBlastRadius("b.ts", { mode: "certain", includeTypeOnly: true }),
    ).resolves.toMatchObject({ total: 1 });
    await expect(api.getCodePreview("a", 1, 2)).rejects.toThrow("no source");
    await expect(api.setKey("anthropic", "x")).rejects.toThrow(
      "no model features",
    );
  });
});
