import { performance } from "node:perf_hooks";
import type { Progress } from "@epoch-dev/core";
import { analyze, openCache } from "@epoch-dev/engine";
import { HostRequest, type HostEvent } from "../shared/host-protocol";

/*
 * The analysis host (an Electron utilityProcess). It runs the same engine as
 * the CLI, against the shared per-user cache, on folders main has checked
 * against the user's granted roots. It reads only inside the given folder
 * (the engine's FsReader) and never executes project code.
 */

const port = process.parentPort;
const cache = openCache();
let queue = Promise.resolve();

/** At most one progress message per interval, plus every stage change and stage end. */
const PROGRESS_INTERVAL_MS = 50;

function send(event: HostEvent): void {
  port.postMessage(event);
}

async function run(request: HostRequest): Promise<void> {
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
  try {
    const { graph } = await analyze(request.root, { cache, onProgress });
    send({ type: "result", id: request.id, graph });
  } catch (error) {
    send({
      type: "error",
      id: request.id,
      message: error instanceof Error ? error.message : String(error),
    });
  }
}

port.on("message", ({ data }) => {
  const parsed = HostRequest.safeParse(data);
  if (!parsed.success) return;
  queue = queue.then(() => run(parsed.data));
});

process.on("exit", () => {
  cache.close();
});
