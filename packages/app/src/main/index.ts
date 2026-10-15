import path from "node:path";
import { app, BrowserWindow, session } from "electron";
import { hardenSession, hardenWebContents } from "./harden";
import { APP_ENTRY_URL, devServerOrigin } from "./policy";
import { registerAppScheme, serveUi } from "./protocol";
import { createProjectWindow } from "./window";

// `electron-vite dev` serves the UI from a local dev server and passes its URL
// in ELECTRON_RENDERER_URL. A packaged app ignores the variable, so nothing in
// the environment can point Epoch at other content.
const devOrigin = app.isPackaged
  ? undefined
  : devServerOrigin(process.env.ELECTRON_RENDERER_URL);
const uiUrl = devOrigin === undefined ? APP_ENTRY_URL : `${devOrigin}/`;

// These must run before "ready".
app.enableSandbox();
registerAppScheme();
app.on("web-contents-created", (_event, contents) => {
  hardenWebContents(contents);
});
app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

async function start(): Promise<void> {
  hardenSession(session.defaultSession, devOrigin);
  serveUi(path.join(import.meta.dirname, "../renderer"));
  await createProjectWindow({ url: uiUrl });
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      void createProjectWindow({ url: uiUrl });
    }
  });
}

// Not a top-level await: Electron emits "ready" only after the ESM main
// module has finished evaluating, so awaiting it here would never resolve
// (verified on Electron 43.7.7).
app.whenReady().then(start, (error: unknown) => {
  console.error(error);
  app.exit(1);
});
