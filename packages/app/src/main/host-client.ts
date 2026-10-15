import { utilityProcess, type UtilityProcess } from "electron";
import type { Graph, Progress } from "@epoch-dev/core";
import { HostEvent, type HostRequest } from "../shared/host-protocol";

interface Pending {
  readonly resolve: (graph: Graph) => void;
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
  private readonly pending = new Map<number, Pending>();
  private nextId = 0;
  private exited = false;

  constructor(entry: string) {
    this.child = utilityProcess.fork(entry, [], {
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

  analyze(root: string, onProgress: (p: Progress) => void): Promise<Graph> {
    if (this.exited) {
      return Promise.reject(new Error("The analysis host has stopped."));
    }
    const id = this.nextId++;
    return new Promise<Graph>((resolve, reject) => {
      this.pending.set(id, { resolve, reject, onProgress });
      const request: HostRequest = { type: "analyze", id, root };
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
    const pending = this.pending.get(event.id);
    if (pending === undefined) return;
    switch (event.type) {
      case "progress":
        pending.onProgress(event.progress);
        break;
      case "result":
        this.pending.delete(event.id);
        // Validated by the engine before it left the host (host-protocol.ts).
        pending.resolve(event.graph as Graph);
        break;
      case "error":
        this.pending.delete(event.id);
        pending.reject(new Error(event.message));
        break;
    }
  }

  private failAll(error: Error): void {
    for (const p of this.pending.values()) p.reject(error);
    this.pending.clear();
  }
}
