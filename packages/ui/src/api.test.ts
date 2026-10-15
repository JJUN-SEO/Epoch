import { describe, expect, it, vi } from "vitest";
import type { Graph, ProjectInfo } from "@epoch-dev/core";
import { createIpcApi, createStaticApi } from "./api";
import type { DesktopBridge } from "./bridge";

const project: ProjectInfo = { root: "/p", name: "p" };
const graph: Graph = {
  schemaVersion: 1,
  nodes: [],
  edges: [],
  roots: [],
  findings: [],
  unresolved: [],
};

const openProject = vi.fn(() => Promise.resolve(project));

function fakeBridge(): DesktopBridge {
  return {
    openProject,
    getGraph: vi.fn(() => Promise.resolve(graph)),
    onProgress: vi.fn(() => () => undefined),
    chooseProject: vi.fn(() => Promise.resolve(null)),
    openDroppedFolder: vi.fn(() => Promise.resolve(project)),
    recentProjects: vi.fn(() => Promise.resolve(["/p"])),
    onProjectOpened: vi.fn(() => () => undefined),
  };
}

describe("createIpcApi", () => {
  it("forwards the M3 methods to the bridge", async () => {
    const bridge = fakeBridge();
    const { api, shell } = createIpcApi(bridge);
    await expect(api.openProject("/p")).resolves.toBe(project);
    expect(openProject).toHaveBeenCalledWith("/p");
    await expect(api.getGraph()).resolves.toBe(graph);
    await expect(shell.recentProjects()).resolves.toEqual(["/p"]);
    await expect(shell.chooseProject()).resolves.toBeNull();
  });

  it("rejects methods of later milestones, naming the milestone", async () => {
    const { api } = createIpcApi(fakeBridge());
    await expect(
      api.getBlastRadius("a", { mode: "certain", includeTypeOnly: true }),
    ).rejects.toThrow("M4");
    await expect(api.getFindings()).rejects.toThrow("M5");
    await expect(api.getSettings()).rejects.toThrow("M7");
  });
});

describe("createStaticApi", () => {
  it("serves one precomputed graph and nothing that needs a machine", async () => {
    const api = createStaticApi(project, graph);
    await expect(api.openProject("/anything")).resolves.toBe(project);
    await expect(api.getGraph()).resolves.toBe(graph);
    await expect(api.getCodePreview("a", 1, 2)).rejects.toThrow("no source");
    await expect(api.setKey("anthropic", "x")).rejects.toThrow(
      "no model features",
    );
  });
});
