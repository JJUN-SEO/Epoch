/*
 * The one module that sends network requests for scorers (CLAUDE.md
 * "Privacy and data flow": every model call goes through a single network
 * wrapper). It refuses anything whose origin is not on the caller's
 * allowlist, so a key or a file can only reach the provider it was meant
 * for, and everything when offline, read at each request so that turning
 * offline mode on takes effect at once; requests in flight can be aborted
 * then. Offline mode may keep a model on this machine (a loopback origin
 * the caller names), since nothing leaves the machine.
 */

export class NetworkBlockedError extends Error {}

export interface NetOptions {
  /** Offline mode, read at each request: every request is refused. */
  readonly offline: boolean | (() => boolean);
  /** Origins requests may go to, e.g. "https://api.anthropic.com". */
  readonly allow: readonly string[];
  /**
   * Origins on this machine (loopback) that offline mode still allows, e.g.
   * a local model the user chose. Also listed in `allow`.
   */
  readonly offlineAllow?: readonly string[];
  /** The underlying fetch (tests pass a fake); the global one by default. */
  readonly fetch?: typeof fetch;
}

export interface Net {
  /** A fetch that enforces the options; pass it to clients that take one. */
  readonly fetch: typeof fetch;
  /** Origin and path of every request sent so far (never queries or bodies). */
  readonly sent: () => readonly string[];
  /** Aborts every request still in flight (offline mode was turned on). */
  readonly abortInFlight: () => void;
}

const LOOPBACK = new Set(["127.0.0.1", "[::1]", "localhost"]);

function urlOf(input: Parameters<typeof fetch>[0]): URL {
  if (input instanceof URL) return input;
  if (typeof input === "string") return new URL(input);
  return new URL(input.url);
}

export function createNet(opts: NetOptions): Net {
  const allowed = new Set(opts.allow.map((o) => new URL(o).origin));
  const offlineAllowed = new Set(
    (opts.offlineAllow ?? []).map((o) => {
      const url = new URL(o);
      if (!LOOPBACK.has(url.hostname)) {
        throw new Error(
          `offline mode can only keep an origin on this machine, and ${url.origin} is not on this machine`,
        );
      }
      return url.origin;
    }),
  );
  const offline =
    typeof opts.offline === "function" ? opts.offline : () => opts.offline;
  const sent: string[] = [];
  const inFlight = new Set<AbortController>();
  const base = opts.fetch ?? globalThis.fetch;
  const guarded: typeof fetch = async (input, init) => {
    let url: URL;
    try {
      url = urlOf(input);
    } catch {
      throw new NetworkBlockedError("not a URL");
    }
    if (offline() === true && !offlineAllowed.has(url.origin)) {
      throw new NetworkBlockedError(
        `offline: refused a request to ${url.origin}`,
      );
    }
    if (!allowed.has(url.origin)) {
      throw new NetworkBlockedError(
        `not an allowed destination: ${url.origin}`,
      );
    }
    sent.push(`${url.origin}${url.pathname}`);
    const controller = new AbortController();
    inFlight.add(controller);
    const signal = init?.signal
      ? AbortSignal.any([init.signal, controller.signal])
      : controller.signal;
    try {
      return await base(input, { ...init, signal });
    } finally {
      inFlight.delete(controller);
    }
  };
  return {
    fetch: guarded,
    sent: () => [...sent],
    abortInFlight: () => {
      for (const c of inFlight) c.abort(new NetworkBlockedError("offline"));
      inFlight.clear();
    },
  };
}
