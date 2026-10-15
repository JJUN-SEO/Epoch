import path from "node:path";

/*
 * Pure security policy for the main process (CLAUDE.md "Electron security").
 * No Electron imports, so every rule is unit-tested; harden.ts applies them.
 */

/** The bundled UI is served from this privileged scheme, never file://. */
export const APP_SCHEME = "epoch";
export const APP_HOST = "app";
export const APP_ORIGIN = `${APP_SCHEME}://${APP_HOST}`;
export const APP_ENTRY_URL = `${APP_ORIGIN}/index.html`;

/**
 * Production Content-Security-Policy. Sent as a header with every UI response
 * and kept identical to the meta tag in packages/ui/index.html (tested).
 */
export const CONTENT_SECURITY_POLICY = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data:",
  "font-src 'self'",
  "worker-src 'self'",
  "connect-src 'self'",
].join("; ");

/**
 * Hosts whose https links may open in the user's default browser. Everything
 * else is dropped. Extend deliberately when the UI links somewhere new.
 */
export const EXTERNAL_LINK_HOSTS: ReadonlySet<string> = new Set(["github.com"]);

function parse(raw: string): URL | undefined {
  try {
    return new URL(raw);
  } catch {
    return undefined;
  }
}

/** True for an https URL on an allowlisted host, with no credentials or port. */
export function isAllowedExternalUrl(raw: string): boolean {
  const url = parse(raw);
  return (
    url?.protocol === "https:" &&
    url.username === "" &&
    url.password === "" &&
    url.port === "" &&
    EXTERNAL_LINK_HOSTS.has(url.hostname)
  );
}

/** The origin of electron-vite's dev server, only when it is a loopback URL. */
export function devServerOrigin(raw: string | undefined): string | undefined {
  if (raw === undefined) return undefined;
  const url = parse(raw);
  if (url?.protocol !== "http:") return undefined;
  return ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)
    ? url.origin
    : undefined;
}

/** True when `raw` belongs to the UI: the app origin, or the dev server in development. */
export function isUiUrl(raw: string, devOrigin?: string): boolean {
  const url = parse(raw);
  if (url === undefined) return false;
  if (url.protocol === `${APP_SCHEME}:`) return url.host === APP_HOST;
  return devOrigin !== undefined && url.origin === devOrigin;
}

/**
 * The only requests the UI session may make: its own files, the dev server
 * (including the HMR WebSocket) in development, and DevTools.
 */
export function isAllowedRequest(raw: string, devOrigin?: string): boolean {
  const url = parse(raw);
  if (url === undefined) return false;
  if (url.protocol === "devtools:") return true;
  if (isUiUrl(raw, devOrigin)) return true;
  if (devOrigin !== undefined && url.protocol === "ws:") {
    return url.host === new URL(devOrigin).host;
  }
  return false;
}

/**
 * Maps a UI URL to a file inside `rendererDir`, or undefined when the URL is
 * not ours or escapes the directory. "/" serves index.html.
 */
export function resolveUiAsset(
  rendererDir: string,
  raw: string,
): string | undefined {
  const url = parse(raw);
  if (url?.protocol !== `${APP_SCHEME}:` || url.host !== APP_HOST) {
    return undefined;
  }
  let pathname: string;
  try {
    pathname = decodeURIComponent(url.pathname);
  } catch {
    return undefined;
  }
  if (pathname.includes("\0") || pathname.includes("\\")) return undefined;
  const relative = pathname === "/" ? "index.html" : pathname.slice(1);
  const root = path.resolve(rendererDir);
  const file = path.resolve(root, relative);
  const inside = path.relative(root, file);
  return inside === "" || inside.startsWith("..") || path.isAbsolute(inside)
    ? undefined
    : file;
}

const MIME_TYPES: Readonly<Record<string, string>> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".wasm": "application/wasm",
};

export function mimeType(file: string): string {
  return (
    MIME_TYPES[path.extname(file).toLowerCase()] ?? "application/octet-stream"
  );
}
