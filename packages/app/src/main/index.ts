import path from "node:path";
import {
  app,
  BrowserWindow,
  ipcMain,
  session,
  type WebContents,
} from "electron";
import { EVENTS } from "../shared/channels";
import { hardenSession, hardenWebContents } from "./harden";
import { HostClient } from "./host-client";
import { createRouter } from "./ipc";
import { APP_ENTRY_URL, devServerOrigin } from "./policy";
import { ProjectSession } from "./project";
import { registerAppScheme, serveUi } from "./protocol";
import { RecentProjects } from "./recent";
import { GrantedRoots } from "./roots";
import { registerRoutes } from "./routes";
import { createProjectWindow } from "./window";

// `electron-vite dev` serves the UI from a local dev server and passes its URL
// in ELECTRON_RENDERER_URL. A packaged app ignores the variable, so nothing in
// the environment can point Epoch at other content.
const devOrigin = app.isPackaged
  ? undefined
  : devServerOrigin(process.env.ELECTRON_RENDERER_URL);
const uiUrl = devOrigin === undefined ? APP_ENTRY_URL : `${devOrigin}/`;

const outDir = path.dirname(import.meta.dirname);
const preload = path.join(outDir, "preload", "index.cjs");
const hostEntry = path.join(import.meta.dirname, "host.js");

/** One project session per window, keyed by its web contents. */
const sessions = new Map<WebContents, ProjectSession>();

// These must run before "ready".
app.enableSandbox();
registerAppScheme();
app.on("web-contents-created", (_event, contents) => {
  hardenWebContents(contents);
});
app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

async function openWindow(): Promise<void> {
  const win = createProjectWindow({ preload });
  const contents = win.webContents;
  sessions.set(
    contents,
    new ProjectSession(
      () => new HostClient(hostEntry),
      (progress) => {
        if (!contents.isDestroyed()) contents.send(EVENTS.progress, progress);
      },
    ),
  );
  win.on("closed", () => {
    sessions.get(contents)?.dispose();
    sessions.delete(contents);
  });
  await win.loadURL(uiUrl);
}

async function start(): Promise<void> {
  hardenSession(session.defaultSession, devOrigin);
  serveUi(path.join(outDir, "renderer"));

  const roots = new GrantedRoots();
  const recent = new RecentProjects(
    path.join(app.getPath("userData"), "recent-projects.json"),
  );
  for (const folder of recent.projects) roots.grantStored(folder);

  const handle = createRouter(
    ipcMain,
    (event) =>
      sessions.has(event.sender)
        ? (BrowserWindow.fromWebContents(event.sender) ?? undefined)
        : undefined,
    devOrigin,
  );
  registerRoutes(handle, {
    roots,
    recent,
    sessionFor: (win) => {
      const s = sessions.get(win.webContents);
      if (s === undefined) throw new Error("Unknown window.");
      return s;
    },
  });

  await openWindow();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) void openWindow();
  });
}

// Not a top-level await: Electron emits "ready" only after the ESM main
// module has finished evaluating, so awaiting it here would never resolve
// (verified on Electron 43.7.7).
app.whenReady().then(start, (error: unknown) => {
  console.error(error);
  app.exit(1);
});
