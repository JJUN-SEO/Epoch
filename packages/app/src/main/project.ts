import path from "node:path";
import {
  applyDelta,
  type AnalysisInfo,
  type Graph,
  type GraphDelta,
  type Progress,
  type ProjectInfo,
  type WatchStatus,
} from "@epoch-dev/core";
import type { Analysis, HostClient, HostListeners } from "./host-client";

/** What a session tells its window about the open project. */
export interface SessionListeners {
  readonly onProgress: (p: Progress) => void;
  readonly onDelta: (delta: GraphDelta) => void;
  readonly onWatchStatus: (status: WatchStatus) => void;
  readonly onAnalysisInfo: (info: AnalysisInfo) => void;
}

/**
 * The project open in one window (CLAUDE.md "App UX basics": one project per
 * window). Opening another folder replaces the analysis host, which cancels
 * the previous analysis and stops its watcher. Watcher deltas are applied
 * here too, so getGraph() always answers with the current graph.
 */
export class ProjectSession {
  private readonly spawnHost: (listeners: HostListeners) => HostClient;
  private readonly listeners: SessionListeners;
  private host: HostClient | undefined;
  private current:
    | {
        info: ProjectInfo;
        analysis: Promise<Analysis>;
        latest?: Analysis;
      }
    | undefined;

  constructor(
    spawnHost: (listeners: HostListeners) => HostClient,
    listeners: SessionListeners,
  ) {
    this.spawnHost = spawnHost;
    this.listeners = listeners;
  }

  /** Starts analyzing a granted folder (a real path) and returns at once. */
  open(root: string): ProjectInfo {
    this.host?.dispose();
    const host = this.spawnHost({
      onDelta: (delta, info) => {
        if (this.host !== host) return;
        this.applyDelta(delta, info);
      },
      onWatchStatus: (status) => {
        if (this.host === host) this.listeners.onWatchStatus(status);
      },
    });
    this.host = host;
    const info: ProjectInfo = { root, name: path.basename(root) };
    const analysis = host.analyze(root, this.listeners.onProgress);
    const current: NonNullable<typeof this.current> = { info, analysis };
    analysis.then(
      (a) => {
        current.latest ??= a;
      },
      // Failures surface through graph(); avoid an unhandled rejection meanwhile.
      () => undefined,
    );
    this.current = current;
    return info;
  }

  graph(): Promise<Graph> {
    const current = this.current;
    if (!current) return Promise.reject(new Error("No project is open."));
    return current.latest
      ? Promise.resolve(current.latest.graph)
      : current.analysis.then((a) => a.graph);
  }

  /** What the latest analysis used; null until the first one finishes. */
  analysisInfo(): AnalysisInfo | null {
    return this.current?.latest?.info ?? null;
  }

  dispose(): void {
    this.host?.dispose();
    this.host = undefined;
    this.current = undefined;
  }

  private applyDelta(delta: GraphDelta, info: AnalysisInfo): void {
    const current = this.current;
    // The host sends its result before it starts watching, so a delta
    // always follows a finished analysis.
    if (!current?.latest) return;
    current.latest = { graph: applyDelta(current.latest.graph, delta), info };
    this.listeners.onDelta(delta);
    this.listeners.onAnalysisInfo(info);
  }
}
