import { utilityProcess, type UtilityProcess } from "electron";
import {
  withoutSecrets,
  type AnalysisInfo,
  type CodePreview,
  type Graph,
  type GraphDelta,
  type Progress,
  type StoredSummary,
  type WatchStatus,
} from "@epoch-dev/core";
import {
  HostEvent,
  type HostRequest,
  type SummaryJobItem,
  type SummaryPlanMessage,
} from "../shared/host-protocol";

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

/** A summary's model, as the host plans and stores it. */
export interface SummaryModel {
  readonly provider: "anthropic" | "local";
  readonly model: string;
}

/** A model's answer, with what it cost, for the host to sanitize and store. */
export interface SummaryAnswer {
  readonly text: string;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly costUsd: number;
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
  /** Requests answered by one event: previews and summary calls. */
  private readonly calls = new Map<
    number,
    { resolve: (e: HostEvent) => void; reject: (e: Error) => void }
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
      // Main's environment without anything that looks like a key or token
      // (core withoutSecrets): the host never needs one.
      env: withoutSecrets(process.env),
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

  private call(make: (id: number) => HostRequest): Promise<HostEvent> {
    if (this.exited) {
      return Promise.reject(new Error("The analysis host has stopped."));
    }
    const id = this.nextId++;
    return new Promise<HostEvent>((resolve, reject) => {
      this.calls.set(id, { resolve, reject });
      this.child.postMessage(make(id));
    });
  }

  /** Lines of a file in `root` (a granted folder), read by the host. */
  async preview(
    root: string,
    file: string,
    startLine: number,
    endLine: number,
  ): Promise<CodePreview> {
    const event = await this.call((id) => ({
      type: "preview",
      id,
      root,
      file,
      startLine,
      endLine,
    }));
    if (event.type !== "preview") throw new Error("Unexpected host answer.");
    return event.preview;
  }

  /**
   * What summarizing `subject` would send, and whether it is stored already.
   * With `withPrompt` the plan carries the text to send, source included:
   * main sends it and never stores or forwards it.
   */
  async planSummary(
    root: string,
    subject: string,
    model: SummaryModel,
    withPrompt: boolean,
  ): Promise<SummaryPlanMessage> {
    const event = await this.call((id) => ({
      type: "summary-plan",
      id,
      root,
      subject,
      model,
      withPrompt,
    }));
    if (event.type !== "summary-plan")
      throw new Error("Unexpected host answer.");
    return event.plan;
  }

  /** Hands a model's answer to a plan back; undefined when nothing of it could be kept. */
  async storeSummary(
    root: string,
    key: string,
    answer: SummaryAnswer,
  ): Promise<StoredSummary | undefined> {
    const event = await this.call((id) => ({
      type: "summary-store",
      id,
      root,
      key,
      answer,
    }));
    if (event.type !== "summary-stored")
      throw new Error("Unexpected host answer.");
    return event.summary;
  }

  /** A folder summary job's subjects, bottom-up, each planned. */
  async summaryJob(
    root: string,
    dir: string,
    model: SummaryModel,
  ): Promise<SummaryJobItem[]> {
    const event = await this.call((id) => ({
      type: "summary-job",
      id,
      root,
      dir,
      model,
    }));
    if (event.type !== "summary-job")
      throw new Error("Unexpected host answer.");
    return event.items;
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
    if (event.type === "network-attempt") {
      // Never expected: the host's tripwire refused it. Reported so tests
      // and users see it; the name is a function, never data.
      console.error(
        `[epoch] the analysis host tried to use the network (${event.name}); refused`,
      );
      return;
    }
    const call = this.calls.get(event.id);
    if (call !== undefined) {
      this.calls.delete(event.id);
      if (event.type === "error") call.reject(new Error(event.message));
      else call.resolve(event);
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
      default:
        break; // answered above
    }
  }

  private failAll(error: Error): void {
    for (const p of this.pending.values()) p.reject(error);
    this.pending.clear();
    for (const c of this.calls.values()) c.reject(error);
    this.calls.clear();
  }
}
