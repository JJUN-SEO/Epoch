import dgram from "node:dgram";
import dns from "node:dns";
import http from "node:http";
import http2 from "node:http2";
import https from "node:https";
import { syncBuiltinESMExports } from "node:module";
import net from "node:net";
import tls from "node:tls";
import { NetworkBlockedError } from "./net.js";

/*
 * For a process that must never use the network: the analysis host, which
 * parses untrusted repositories, and main outside its one egress (CLAUDE.md
 * "Offline mode": enforced in main and the analysis host). It replaces
 * Node's ways out (fetch, sockets, TLS, HTTP, HTTP/2, DNS, UDP) with ones
 * that refuse and count. A worker thread has its own modules and installs
 * its own. It is a guard and a witness for tests, not a sandbox: native
 * code can still open sockets, which the zero-network CI run catches at the
 * kernel level.
 */

export interface Tripwire {
  /** What was attempted, in order (the function's name, never its arguments). */
  attempts(): readonly string[];
  /** Puts the original functions back. */
  uninstall(): void;
}

export function installTripwire(): Tripwire {
  const seen: string[] = [];
  const restores: (() => void)[] = [];
  const refuse = (name: string) => {
    seen.push(name);
    return new NetworkBlockedError(
      `network is off in this process: refused ${name}`,
    );
  };
  // Replaced through a plain record: these objects are typed as fixed APIs.
  const replace = (
    target: object,
    key: string,
    name: string,
    how: "throw" | "reject",
  ) => {
    const slots = target as Record<string, unknown>;
    const original = slots[key];
    restores.push(() => {
      slots[key] = original;
    });
    slots[key] =
      how === "reject"
        ? () => Promise.reject(refuse(name))
        : () => {
            throw refuse(name);
          };
  };
  replace(globalThis, "fetch", "fetch", "reject");
  replace(net, "connect", "net.connect", "throw");
  replace(net, "createConnection", "net.createConnection", "throw");
  replace(net.Socket.prototype, "connect", "net.Socket.connect", "throw");
  replace(tls, "connect", "tls.connect", "throw");
  replace(http, "request", "http.request", "throw");
  replace(http, "get", "http.get", "throw");
  replace(https, "request", "https.request", "throw");
  replace(https, "get", "https.get", "throw");
  replace(http2, "connect", "http2.connect", "throw");
  for (const key of [
    "lookup",
    "resolve",
    "resolve4",
    "resolve6",
    "resolveAny",
  ]) {
    replace(dns, key, `dns.${key}`, "throw");
    replace(dns.promises, key, `dns.promises.${key}`, "reject");
  }
  replace(dgram, "createSocket", "dgram.createSocket", "throw");
  // Named imports of built-in modules see the replacements too.
  syncBuiltinESMExports();
  return {
    attempts: () => [...seen],
    uninstall: () => {
      for (const restore of restores.reverse()) restore();
      restores.length = 0;
      syncBuiltinESMExports();
    },
  };
}
