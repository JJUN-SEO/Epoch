/*
 * The one module that sends network requests for scorers (CLAUDE.md
 * "Privacy and data flow": every model call goes through a single network
 * wrapper). It refuses everything when offline, and anything whose origin
 * is not on the caller's allowlist, so a key or a file can only reach the
 * provider it was meant for. M7 turns this into the app-wide wrapper.
 */

export class NetworkBlockedError extends Error {}

export interface NetOptions {
  /** Offline mode: every request is refused. */
  readonly offline: boolean;
  /** Origins requests may go to, e.g. "https://api.anthropic.com". */
  readonly allow: readonly string[];
  /** The underlying fetch (tests pass a fake); the global one by default. */
  readonly fetch?: typeof fetch;
}

export interface Net {
  /** A fetch that enforces the options; pass it to clients that take one. */
  readonly fetch: typeof fetch;
  /** Origin and path of every request sent so far (never queries or bodies). */
  readonly sent: () => readonly string[];
}

function urlOf(input: Parameters<typeof fetch>[0]): URL {
  if (input instanceof URL) return input;
  if (typeof input === "string") return new URL(input);
  return new URL(input.url);
}

export function createNet(opts: NetOptions): Net {
  const allowed = new Set(opts.allow.map((o) => new URL(o).origin));
  const sent: string[] = [];
  const base = opts.fetch ?? globalThis.fetch;
  const guarded: typeof fetch = (input, init) => {
    let url: URL;
    try {
      url = urlOf(input);
    } catch {
      return Promise.reject(new NetworkBlockedError("not a URL"));
    }
    if (opts.offline) {
      return Promise.reject(
        new NetworkBlockedError(`offline: refused a request to ${url.origin}`),
      );
    }
    if (!allowed.has(url.origin)) {
      return Promise.reject(
        new NetworkBlockedError(`not an allowed destination: ${url.origin}`),
      );
    }
    sent.push(`${url.origin}${url.pathname}`);
    return base(input, init);
  };
  return { fetch: guarded, sent: () => [...sent] };
}
