import { readFile } from "node:fs/promises";
import { protocol } from "electron";
import {
  APP_SCHEME,
  CONTENT_SECURITY_POLICY,
  mimeType,
  resolveUiAsset,
} from "./policy";

/**
 * Registers the app scheme as a standard, secure origin. Must run before the
 * app is ready. Electron recommends a custom protocol over file:// for local
 * UI ("Security", recommendation 18): file:// pages get broad local access.
 */
export function registerAppScheme(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: APP_SCHEME,
      privileges: { standard: true, secure: true, supportFetchAPI: true },
    },
  ]);
}

/** Serves the bundled UI from `rendererDir`, read-only, with the CSP header. */
export function serveUi(rendererDir: string): void {
  protocol.handle(APP_SCHEME, async (request) => {
    const file = resolveUiAsset(rendererDir, request.url);
    if (file === undefined || request.method !== "GET") {
      return new Response(null, { status: 404 });
    }
    try {
      return new Response(await readFile(file), {
        headers: {
          "Content-Type": mimeType(file),
          "Content-Security-Policy": CONTENT_SECURITY_POLICY,
          "X-Content-Type-Options": "nosniff",
        },
      });
    } catch {
      return new Response(null, { status: 404 });
    }
  });
}
