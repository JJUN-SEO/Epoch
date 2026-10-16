import { Worker } from "node:worker_threads";
import { afterEach, describe, expect, it } from "vitest";
import { installTripwire, type Tripwire } from "./tripwire.js";

/*
 * The tripwire stands in a process that must never use the network (the
 * analysis host, main outside its one egress, the zero-network test). Each
 * canary below is a real attempt; every one must be refused and counted.
 */

let wire: Tripwire | undefined;
afterEach(() => {
  wire?.uninstall();
  wire = undefined;
});

const attempts: [string, () => Promise<unknown>][] = [
  ["fetch", () => fetch("https://example.com/")],
  [
    "net.connect",
    async () => (await import("node:net")).connect(443, "example.com"),
  ],
  [
    "net.createConnection",
    async () => (await import("node:net")).createConnection(443, "example.com"),
  ],
  [
    "net.Socket.connect",
    async () =>
      new (await import("node:net")).Socket().connect(443, "example.com"),
  ],
  [
    "tls.connect",
    async () => (await import("node:tls")).connect(443, "example.com"),
  ],
  [
    "http.request",
    async () => (await import("node:http")).request("http://example.com/"),
  ],
  [
    "http.get",
    async () => (await import("node:http")).get("http://example.com/"),
  ],
  [
    "https.request",
    async () => (await import("node:https")).request("https://example.com/"),
  ],
  [
    "https.get",
    async () => (await import("node:https")).get("https://example.com/"),
  ],
  [
    "http2.connect",
    async () => (await import("node:http2")).connect("https://example.com"),
  ],
  [
    "dns.lookup",
    async () => {
      (await import("node:dns")).lookup("example.com", () => undefined);
    },
  ],
  [
    "dns.resolve",
    async () => {
      (await import("node:dns")).resolve("example.com", () => undefined);
    },
  ],
  [
    "dns.promises.lookup",
    async () => (await import("node:dns")).promises.lookup("example.com"),
  ],
  [
    "dgram.createSocket",
    async () => (await import("node:dgram")).createSocket("udp4"),
  ],
];

describe("installTripwire", () => {
  it.each(attempts)("refuses and counts %s", async (name, attempt) => {
    wire = installTripwire();
    await expect(attempt()).rejects.toThrow("network is off");
    expect(wire.attempts()).toEqual([name]);
  });

  it("puts everything back when uninstalled", async () => {
    const before = globalThis.fetch;
    const net = await import("node:net");
    const connect = net.connect;
    wire = installTripwire();
    expect(globalThis.fetch).not.toBe(before);
    // The one door out still has the real fetch underneath.
    expect(wire.passthrough).toBe(before);
    wire.uninstall();
    wire = undefined;
    expect(globalThis.fetch).toBe(before);
    expect(net.connect).toBe(connect);
  });

  it("works inside a worker thread too", async () => {
    // Each worker has its own modules, so it installs its own tripwire.
    // Node runs the TypeScript source here; its "./net.js" import names the
    // compiled file, so a resolve hook maps it to the source.
    const code = `
      const { parentPort } = require("node:worker_threads");
      require("node:module").registerHooks({
        resolve(specifier, context, next) {
          try { return next(specifier, context); }
          catch (err) {
            if (!specifier.endsWith(".js")) throw err;
            return next(specifier.slice(0, -3) + ".ts", context);
          }
        },
      });
      const { installTripwire } = require(${JSON.stringify(
        new URL("./tripwire.ts", import.meta.url).pathname,
      )});
      const wire = installTripwire();
      const out = [];
      try { require("node:net").connect(443, "example.com"); } catch (e) { out.push(String(e.message)); }
      out.push(wire.attempts().join(","));
      parentPort.postMessage(out);
    `;
    const result = await new Promise<string[]>((resolve, reject) => {
      const worker = new Worker(code, { eval: true });
      worker.once("message", (m: string[]) => {
        resolve(m);
        void worker.terminate();
      });
      worker.once("error", reject);
    });
    expect(result[0]).toContain("network is off");
    expect(result[1]).toBe("net.connect");
  });
});
