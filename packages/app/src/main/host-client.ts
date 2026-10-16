import { utilityProcess, type UtilityProcess } from "electron";
import type {
  AnalysisInfo,
  CodePreview,
  Graph,
  GraphDelta,
  Progress,
  WatchStatus,
} from "@epoch-dev/core";
import { HostEvent, type HostRequest } from "../shared/host-protocol";

/** A finished analysis: the graph and what it used. */
export interface Analysis {
  readonly graph: Graph;
  readonly info: AnalysisInfo;
}

/** What the host reports on its own after an analysis: the watcher's work. */
export interface HostListeners {
  readonly onDelta: (delta: GraphDelta, info: AnalysisInfo) => void;
  readonly onWatchStatus: (status: WatchStatus) => void;
}

interface Pending {
  readonly resolve: (analysis: Analysis) => void;
  readonly reject: (error: Error) => void;
  readonly onProgress: (p: Progress) => void;
}

/**
 * One analysis host: a utilityProcess running the engine, the SQLite cache
 * and the parsers, so heavy work never runs in main or the renderer
 * (CLAUDE.md "Architecture"). Killing it cancels whatever it was doing.
 */
export class HostClient {
  private readonly child: UtilityProcess;
  private readonly listeners: HostListeners;
  private readonly pending = new Map<number, Pending>();
  private readonly previews = new Map<
    number,
    { resolve: (p: CodePreview) => void; reject: (e: Error) => void }
  >();
  private nextId = 0;
  private exited = false;

  /** `args`: the host's command line (the local model's folder, main/model.ts). */
  constructor(
    entry: string,
    listeners: HostListeners,
    args: readonly string[] = [],
  ) {
    this.listeners = listeners;
    this.child = utilityProcess.fork(entry, [...args], {
      serviceName: "Epoch analysis host",
    });
    this.child.on("message", (message: unknown) => {
      this.receive(message);
    });
    this.child.on("exit", (code) => {
      this.exited = true;
      this.failAll(
        new Error(`The analysis host stopped (exit code ${String(code)}).`),
      );
    });
  }

  analyze(root: string, onProgress: (p: Progress) => void): Promise<Analysis> {
    if (this.exited) {
      return Promise.reject(new Error("The analysis host has stopped."));
    }
    const id = this.nextId++;
    return new Promise<Analysis>((resolve, reject) => {
      this.pending.set(id, { resolve, reject, onProgress });
      const request: HostRequest = { type: "analyze", id, root };
      this.child.postMessage(request);
    });
  }

  /** Lines of a file in `root` (a granted folder), read by the host. */
  preview(
    root: string,
    file: string,
    startLine: number,
    endLine: number,
  ): Promise<CodePreview> {
    if (this.exited) {
      return Promise.reject(new Error("The analysis host has stopped."));
    }
    const id = this.nextId++;
    return new Promise<CodePreview>((resolve, reject) => {
      this.previews.set(id, { resolve, reject });
      const request: HostRequest = {
        type: "preview",
        id,
        root,
        file,
        startLine,
        endLine,
      };
      this.child.postMessage(request);
    });
  }

  dispose(): void {
    this.failAll(new Error("The analysis was replaced or its window closed."));
    if (!this.exited) this.child.kill();
  }

  private receive(message: unknown): void {
    const parsed = HostEvent.safeParse(message);
    if (!parsed.success) return;
    const event = parsed.data;
    if (event.type === "delta") {
      // Computed by core's diffGraphs from validated graphs (host-protocol.ts).
      this.listeners.onDelta(event.delta as GraphDelta, event.info);
      return;
    }
    if (event.type === "watch-status") {
      this.listeners.onWatchStatus(event.status);
      return;
    }
    const preview = this.previews.get(event.id);
    if (preview !== undefined) {
      this.previews.delete(event.id);
      if (event.type === "preview") preview.resolve(event.preview);
      else if (event.type === "error") preview.reject(new Error(event.message));
      return;
    }
    const pending = this.pending.get(event.id);
    if (pending === undefined) return;
    switch (event.type) {
      case "progress":
        pending.onProgress(event.progress);
        break;
      case "result":
        this.pending.delete(event.id);
        // Validated by the engine before it left the host (host-protocol.ts).
        pending.resolve({ graph: event.graph as Graph, info: event.info });
        break;
      case "error":
        this.pending.delete(event.id);
        pending.reject(new Error(event.message));
        break;
      case "preview":
        break; // answered above
    }
  }

  private failAll(error: Error): void {
    for (const p of this.pending.values()) p.reject(error);
    this.pending.clear();
    for (const p of this.previews.values()) p.reject(error);
    this.previews.clear();
  }
}
