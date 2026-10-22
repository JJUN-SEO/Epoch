// The zero-network test (PLAN.md M7 acceptance; CLAUDE.md "Offline mode":
// a full analysis with the network blocked makes no requests). Loaded with
// `node --import ./scripts/no-network.mjs`, it runs in the main thread and
// in every worker thread, which inherit the flag: each installs Epoch's
// tripwire and appends every network attempt to $EPOCH_NETWORK_LOG, one
// line per attempt ("main fetch", "worker 3 dns.lookup"). An empty log
// after a run means nothing was attempted.
//
// With EPOCH_NETWORK_CANARY=1 the main thread first makes attempts of its
// own, there and in a worker, which must show up in the log: proof that
// the log would catch them, so an empty log is not an empty test.
import fs from "node:fs";
import process from "node:process";
import { URL } from "node:url";
import { isMainThread, threadId, Worker } from "node:worker_threads";
import { installTripwire } from "../packages/scorers/dist/tripwire.js";

const log = process.env.EPOCH_NETWORK_LOG;
if (!log) throw new Error("no-network.mjs needs EPOCH_NETWORK_LOG");
const where = isMainThread ? "main" : `worker ${String(threadId)}`;
installTripwire({
  onAttempt: (name) => {
    fs.appendFileSync(log, `${where} ${name}\n`);
  },
});

if (isMainThread && process.env.EPOCH_NETWORK_CANARY === "1") {
  const canary = new URL("./no-network-canary.mjs", import.meta.url);
  await (await import(canary.href)).attempt();
  await new Promise((resolve, reject) => {
    const worker = new Worker(canary);
    worker.once("exit", resolve);
    worker.once("error", reject);
  });
}
