import type { Plugin } from "vite";

/**
 * The Content-Security-Policy meta tag in index.html is the production policy
 * (the desktop app also sends it as a header and tests that the two match).
 * Vite's dev server needs a looser one: React Refresh injects an inline module
 * script, CSS arrives as inline <style> tags, and HMR uses a WebSocket.
 */
export const DEV_CSP =
  "default-src 'none'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; worker-src 'self'; connect-src 'self' ws://localhost:*";

const META_CONTENT = /(http-equiv="Content-Security-Policy"\s+content=")[^"]*/;

export function withDevCsp(html: string): string {
  if (!META_CONTENT.test(html)) {
    throw new Error("index.html has no Content-Security-Policy meta tag");
  }
  return html.replace(META_CONTENT, `$1${DEV_CSP}`);
}

/** Swaps in DEV_CSP for `vite serve` only; builds keep the strict policy. */
export function devCsp(): Plugin {
  return {
    name: "epoch-dev-csp",
    apply: "serve",
    transformIndexHtml: withDevCsp,
  };
}
