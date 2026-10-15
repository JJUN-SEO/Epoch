import { shell, type Session, type WebContents } from "electron";
import { isAllowedExternalUrl, isAllowedRequest } from "./policy";

/*
 * Applies the policy in policy.ts to Electron (CLAUDE.md "Electron security").
 * The e2e security tests exercise every rule against the running app.
 */

/** Opens an allowlisted https link in the default browser; drops anything else. */
export function openExternally(url: string): void {
  if (isAllowedExternalUrl(url)) void shell.openExternal(url);
}

/**
 * Denies every permission request (camera, notifications, ...) and cancels
 * every request that is not the bundled UI, the dev server in development, or
 * DevTools. The app has no remote content.
 */
export function hardenSession(
  ses: Session,
  devOrigin: string | undefined,
): void {
  ses.setPermissionRequestHandler((_contents, _permission, callback) => {
    callback(false);
  });
  ses.setPermissionCheckHandler(() => false);
  ses.setDevicePermissionHandler(() => false);
  ses.webRequest.onBeforeRequest((details, callback) => {
    callback({ cancel: !isAllowedRequest(details.url, devOrigin) });
  });
}

/**
 * Applied to every WebContents the app creates: no navigation away from the
 * loaded page, no new windows, no <webview>. Links to allowlisted hosts go to
 * the default browser instead.
 */
export function hardenWebContents(contents: WebContents): void {
  contents.on("will-navigate", (event) => {
    event.preventDefault();
    openExternally(event.url);
  });
  contents.on("will-frame-navigate", (event) => {
    if (!event.isMainFrame) event.preventDefault();
  });
  contents.on("will-attach-webview", (event) => {
    event.preventDefault();
  });
  contents.setWindowOpenHandler(({ url }) => {
    openExternally(url);
    return { action: "deny" };
  });
}
