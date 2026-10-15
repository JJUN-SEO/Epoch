import path from "node:path";
import { performance } from "node:perf_hooks";
import {
  diffGraphs,
  isEmptyDelta,
  type AnalysisInfo,
  type Graph,
  type Progress,
} from "@epoch-dev/core";
import {
  ChurnMemo,
  ParsePool,
  analyze,
  openCache,
  watchProject,
  type AnalyzeResult,
  type ProjectWatcher,
} from "@epoch-dev/engine";
import { HostRequest, type HostEvent } from "../shared/host-protocol";

/*
 * The analysis host (an Electron utilityProcess). It runs the same engine as
 * the CLI, against the shared per-user cache, on folders main has checked
 * against the user's granted roots. It reads only inside the given folder
 * (the engine's FsReader) and never executes project code. After an analysis
 * it watches the folder and sends main the difference each time the graph
 * changes.
 */

const port = process.parentPort;
const cache = openCache();
// The bundled worker sits next to this file (electron.vite.config.ts).
const pool = new ParsePool({
  workerFile: path.join(import.meta.dirname, "parse-worker.js"),
});
const churnMemo = new ChurnMemo();
let queue = Promise.resolve();
let watcher: ProjectWatcher | undefined;

/** At most one progress message per interval, plus every stage change and stage end. */
const PROGRESS_INTERVAL_MS = 50;

function send(event: HostEvent): void {
  port.postMessage(event);
}

const infoOf = (r: AnalyzeResult): AnalysisInfo => ({
  git: r.meta.git,
  coverage: r.meta.coverage,
});

async function run(request: HostRequest): Promise<void> {
  await watcher?.close();
  watcher = undefined;
  let lastStage: Progress["stage"] | undefined;
  let lastSent = 0;
  const onProgress = (progress: Progress) => {
    const now = performance.now();
    if (
      progress.stage !== lastStage ||
      progress.done === progress.total ||
      now - lastSent >= PROGRESS_INTERVAL_MS
    ) {
      lastStage = progress.stage;
      lastSent = now;
      send({ type: "progress", id: request.id, progress });
    }
  };
  const options = { cache, pool, churnMemo };
  let result: AnalyzeResult;
  try {
    result = await analyze(request.root, { ...options, onProgress });
  } catch (error) {
    send({
      type: "error",
      id: request.id,
      message: error instanceof Error ? error.message : String(error),
    });
    return;
  }
  send({
    type: "result",
    id: request.id,
    graph: result.graph,
    info: infoOf(result),
  });
  let graph: Graph = result.graph;
  let info = JSON.stringify(infoOf(result));
  watcher = await watchProject(result, {
    analyze: options,
    onUpdate: (next) => {
      const delta = diffGraphs(graph, next.graph);
      const nextInfo = infoOf(next);
      if (isEmptyDelta(delta) && JSON.stringify(nextInfo) === info) return;
      graph = next.graph;
      info = JSON.stringify(nextInfo);
      send({ type: "delta", delta, info: nextInfo });
    },
    onStatus: (status) => {
      send({ type: "watch-status", status });
    },
  });
}

port.on("message", ({ data }) => {
  const parsed = HostRequest.safeParse(data);
  if (!parsed.success) return;
  queue = queue.then(() => run(parsed.data));
});

process.on("exit", () => {
  cache.close();
});
