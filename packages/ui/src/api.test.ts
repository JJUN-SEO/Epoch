import { describe, expect, it, vi } from "vitest";
import {
  DEFAULT_SETTINGS,
  blastRadius,
  filterFindings,
  type Graph,
  type GraphDelta,
  type ProjectInfo,
} from "@epoch-dev/core";
import { createIpcApi, createStaticApi } from "./api";
import type { DesktopBridge } from "./bridge";
import { edge, graph as testGraph, node } from "./graph/test-graph";

const project: ProjectInfo = { root: "/p", name: "p" };
const graph: Graph = testGraph(["a.ts", "b.ts"], [edge("a.ts", "b.ts")]);

const openProject = vi.fn(() => Promise.resolve(project));
const showAppMenu = vi.fn(() => Promise.resolve());
const getSummary = vi.fn(() =>
  Promise.resolve({
    state: "unavailable" as const,
    subject: "a.ts",
    reason: "disabled" as const,
  }),
);
const updateSettings = vi.fn(() =>
  Promise.resolve({ ...DEFAULT_SETTINGS, offline: true }),
);
const getFindings = vi.fn(() => Promise.resolve([]));
const dismissFinding = vi.fn(() => Promise.resolve());
const getCodePreview = vi.fn(() =>
  Promise.resolve({ file: "a.ts", startLine: 1, lines: ["x"] }),
);

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
    getFindings,
    dismissFinding,
    undismissFinding: vi.fn(() => Promise.resolve()),
    getCodePreview,
    getAnalysisInfo: vi.fn(() => Promise.resolve(null)),
    onAnalysisInfo: vi.fn(() => () => undefined),
    chooseProject: vi.fn(() => Promise.resolve(null)),
    openDroppedFolder: vi.fn(() => Promise.resolve(project)),
    recentProjects: vi.fn(() => Promise.resolve(["/p"])),
    onProjectOpened: vi.fn(() => () => undefined),
    showAppMenu: showAppMenu,
    onMenuCommand: vi.fn(() => () => undefined),
    getSettings: vi.fn(() => Promise.resolve(DEFAULT_SETTINGS)),
    updateSettings,
    onSettingsChanged: vi.fn(() => () => undefined),
    setKey: vi.fn(() => Promise.resolve()),
    removeKey: vi.fn(() => Promise.resolve()),
    getKeyStatus: vi.fn(() => Promise.resolve({ configured: false })),
    getSummary,
    generateSummary: vi.fn(() =>
      Promise.resolve({
        state: "failed" as const,
        subject: "",
        reason: "expired" as const,
      }),
    ),
    cancelSummaries: vi.fn(() => Promise.resolve()),
    resetSpend: vi.fn(() =>
      Promise.resolve({
        month: "2026-10",
        monthUsd: 0,
        sessionUsd: 0,
        sessionBudgetUsd: 1,
        heldUsd: 0,
      }),
    ),
    getCacheStats: vi.fn(() =>
      Promise.resolve({
        bytes: 0,
        facts: 0,
        derived: 0,
        summaries: { paid: 0, local: 0 },
      }),
    ),
    clearCache: vi.fn(() =>
      Promise.resolve({
        bytes: 0,
        facts: 0,
        derived: 0,
        summaries: { paid: 0, local: 0 },
      }),
    ),
    getUpdateStatus: vi.fn(() => Promise.resolve(null)),
    onUpdateAvailable: vi.fn(() => () => undefined),
    onSummaryProgress: vi.fn(() => () => undefined),
    getSpend: vi.fn(() =>
      Promise.resolve({
        month: "2026-10",
        monthUsd: 0,
        sessionUsd: 0,
        sessionBudgetUsd: 1,
        heldUsd: 0,
      }),
    ),
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

  it("forwards findings, dismissals and code previews to the bridge", async () => {
    const { api } = createIpcApi(fakeBridge().bridge);
    await expect(api.getFindings({ minConfidence: "high" })).resolves.toEqual(
      [],
    );
    expect(getFindings).toHaveBeenCalledWith({ minConfidence: "high" });
    await api.dismissFinding("abc", "kept");
    expect(dismissFinding).toHaveBeenCalledWith("abc", "kept");
    await expect(api.getCodePreview("a.ts", 1, 1)).resolves.toMatchObject({
      lines: ["x"],
    });
    expect(getCodePreview).toHaveBeenCalledWith("a.ts", 1, 1);
  });

  it("reads and changes settings through the bridge", async () => {
    const { bridge } = fakeBridge();
    const { api } = createIpcApi(bridge);
    await expect(api.getSettings()).resolves.toEqual(DEFAULT_SETTINGS);
    await expect(api.updateSettings({ offline: true })).resolves.toMatchObject({
      offline: true,
    });
    expect(updateSettings).toHaveBeenCalledWith({ offline: true });
  });

  it("asks main for summaries", async () => {
    const { api } = createIpcApi(fakeBridge().bridge);
    await expect(api.getSummary("a.ts", { auto: true })).resolves.toMatchObject(
      { state: "unavailable" },
    );
    expect(getSummary).toHaveBeenCalledWith("a.ts", { auto: true });
  });
});

describe("createStaticApi", () => {
  it("computes blast radius with core's function, as the app does", async () => {
    const api = createStaticApi(project, graph);
    const opts = { mode: "certain", includeTypeOnly: true } as const;
    await expect(api.getBlastRadius("b.ts", opts)).resolves.toEqual(
      blastRadius(graph, "b.ts", opts),
    );
  });

  it("filters the precomputed findings like the app", async () => {
    const api = createStaticApi(project, graph);
    await expect(
      api.getFindings({ kinds: ["stale-flag"], minConfidence: "high" }),
    ).resolves.toEqual(
      filterFindings(graph.findings, {
        kinds: ["stale-flag"],
        minConfidence: "high",
      }),
    );
  });

  it("refuses everything that needs a machine, with fixed messages", async () => {
    const api = createStaticApi(project, graph);
    await expect(api.getSettings()).rejects.toThrow(
      "The demo has no settings.",
    );
    await expect(api.getSummary("a.ts")).rejects.toThrow(
      "The demo has no model features.",
    );
    await expect(api.getSpend()).rejects.toThrow(
      "The demo has no model features.",
    );
    await expect(api.undismissFinding("x")).rejects.toThrow(
      "The demo cannot dismiss findings.",
    );
  });

  it("serves one precomputed graph and nothing that needs a machine", async () => {
    const api = createStaticApi(project, graph);
    await expect(api.openProject("/anything")).resolves.toBe(project);
    await expect(api.getGraph()).resolves.toBe(graph);
    await expect(
      api.getBlastRadius("b.ts", { mode: "certain", includeTypeOnly: true }),
    ).resolves.toMatchObject({ total: 1 });
    await expect(api.getCodePreview("a", 1, 2)).rejects.toThrow("no source");
    await expect(api.getFindings()).resolves.toEqual(graph.findings);
    await expect(api.dismissFinding("x")).rejects.toThrow("cannot dismiss");
    await expect(api.setKey("anthropic", "x")).rejects.toThrow(
      "no model features",
    );
  });
});
