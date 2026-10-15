import path from "node:path";
import type { Graph, Progress, ProjectInfo } from "@epoch-dev/core";
import type { HostClient } from "./host-client";

/**
 * The project open in one window (CLAUDE.md "App UX basics": one project per
 * window). Opening another folder replaces the analysis host, which cancels
 * the previous analysis.
 */
export class ProjectSession {
  private readonly spawnHost: () => HostClient;
  private readonly onProgress: (p: Progress) => void;
  private host: HostClient | undefined;
  private current: { info: ProjectInfo; graph: Promise<Graph> } | undefined;

  constructor(spawnHost: () => HostClient, onProgress: (p: Progress) => void) {
    this.spawnHost = spawnHost;
    this.onProgress = onProgress;
  }

  /** Starts analyzing a granted folder (a real path) and returns at once. */
  open(root: string): ProjectInfo {
    this.host?.dispose();
    const host = this.spawnHost();
    this.host = host;
    const info: ProjectInfo = { root, name: path.basename(root) };
    const graph = host.analyze(root, this.onProgress);
    // Failures surface through getGraph(); avoid an unhandled rejection meanwhile.
    graph.catch(() => undefined);
    this.current = { info, graph };
    return info;
  }

  graph(): Promise<Graph> {
    return (
      this.current?.graph ?? Promise.reject(new Error("No project is open."))
    );
  }

  dispose(): void {
    this.host?.dispose();
    this.host = undefined;
    this.current = undefined;
  }
}
