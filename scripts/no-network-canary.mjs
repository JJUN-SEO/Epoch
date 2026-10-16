// Network attempts for the canary of scripts/no-network.mjs, made in the
// main thread and, as this file, in a worker thread: a file worker, as the
// parse workers are (the preload runs in file workers, not in eval ones).
// TEST-NET-1 (RFC 5737) and .invalid (RFC 2606): nothing answers there,
// even if a guard failed.
import dns from "node:dns";
import net from "node:net";

export async function attempt() {
  try {
    net.connect(9, "192.0.2.1");
  } catch {
    // Refused by the tripwire, as it should be.
  }
  try {
    dns.lookup("canary.invalid", () => undefined);
  } catch {
    // Refused.
  }
  await globalThis.fetch("http://192.0.2.1:9/").catch(() => undefined);
}

const { isMainThread } = await import("node:worker_threads");
if (!isMainThread) await attempt();
