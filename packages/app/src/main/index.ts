import path from "node:path";
import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  screen,
  session,
  type WebContents,
} from "electron";
import type { ProjectInfo } from "@epoch-dev/core";
import { EVENTS } from "../shared/channels";
import { hardenSession, hardenWebContents, openExternally } from "./harden";
import { HostClient } from "./host-client";
import { createRouter } from "./ipc";
import { buildMenu } from "./menu";
import { embeddingModelDir, hostModelArgs } from "./model";
import { APP_ENTRY_URL, devServerOrigin } from "./policy";
import { ProjectSession } from "./project";
import { Projects } from "./projects";
import { registerAppScheme, serveUi } from "./protocol";
import { RecentProjects } from "./recent";
import { GrantedRoots } from "./roots";
import { registerRoutes } from "./routes";
import { SettingsStore } from "./settings-store";
import { createProjectWindow } from "./window";
import { isReachable, loadWindowState, saveWindowState } from "./window-state";

const REPOSITORY_URL = "https://github.com/JJUN-SEO/under-construction-";

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
// The local embedding model the host may use (bundled; never downloaded).
const hostArgs = hostModelArgs(
  embeddingModelDir({
    packaged: app.isPackaged,
    resourcesPath: process.resourcesPath,
    appPath: app.getAppPath(),
    env: process.env,
  }),
);

/** One project session per window, keyed by its web contents. */
const sessions = new Map<WebContents, ProjectSession>();

function sessionFor(win: BrowserWindow): ProjectSession {
  const s = sessions.get(win.webContents);
  if (s === undefined) throw new Error("Unknown window.");
  return s;
}

// These must run before "ready".
app.enableSandbox();
registerAppScheme();
app.on("web-contents-created", (_event, contents) => {
  hardenWebContents(contents);
});
app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

async function openWindow(stateFile: string): Promise<BrowserWindow> {
  const saved = loadWindowState(stateFile);
  const reachable =
    saved !== undefined &&
    isReachable(
      saved,
      screen.getAllDisplays().map((d) => d.workArea),
    );
  const win = createProjectWindow({
    preload,
    ...(reachable ? { bounds: saved } : {}),
  });
  if (reachable && saved.maximized) win.maximize();
  const contents = win.webContents;
  sessions.set(
    contents,
    new ProjectSession(
      (listeners) => new HostClient(hostEntry, listeners, hostArgs),
      {
        onProgress: (progress) => {
          if (!contents.isDestroyed()) contents.send(EVENTS.progress, progress);
        },
        onDelta: (delta) => {
          if (!contents.isDestroyed()) contents.send(EVENTS.graphDelta, delta);
        },
        onWatchStatus: (status) => {
          if (!contents.isDestroyed())
            contents.send(EVENTS.watchStatus, status);
        },
        onAnalysisInfo: (info) => {
          if (!contents.isDestroyed()) contents.send(EVENTS.analysisInfo, info);
        },
      },
    ),
  );
  win.on("close", () => {
    saveWindowState(stateFile, {
      ...win.getNormalBounds(),
      maximized: win.isMaximized(),
    });
  });
  win.on("closed", () => {
    sessions.get(contents)?.dispose();
    sessions.delete(contents);
  });
  await win.loadURL(uiUrl);
  return win;
}

async function start(): Promise<void> {
  hardenSession(session.defaultSession, devOrigin);
  serveUi(path.join(outDir, "renderer"));

  const userData = app.getPath("userData");
  const stateFile = path.join(userData, "window-state.json");
  const roots = new GrantedRoots();
  const recent = new RecentProjects(
    path.join(userData, "recent-projects.json"),
  );
  for (const folder of recent.projects) roots.grantStored(folder);
  const settings = new SettingsStore(path.join(userData, "settings.json"));
  for (const warning of settings.warnings)
    console.error(`[epoch] settings: ${warning}`);
  settings.onChange((next) => {
    for (const win of BrowserWindow.getAllWindows())
      if (!win.isDestroyed())
        win.webContents.send(EVENTS.settingsChanged, next);
  });

  /** Tells a window's UI about a project opened from the menu. */
  const announce = (win: BrowserWindow, project: ProjectInfo | null) => {
    if (project !== null && !win.isDestroyed()) {
      win.webContents.send(EVENTS.projectOpened, project);
    }
  };
  const targetWindow = async (): Promise<BrowserWindow> =>
    BrowserWindow.getFocusedWindow() ??
    BrowserWindow.getAllWindows()[0] ??
    (await openWindow(stateFile));

  const refreshMenu = () => {
    Menu.setApplicationMenu(
      buildMenu({
        recent: projects.recentProjects(),
        development: !app.isPackaged,
        openProject: () => {
          void targetWindow().then(async (win) => {
            announce(win, await projects.choose(win));
          });
        },
        openRecent: (folder) => {
          void targetWindow().then((win) => {
            announce(win, projects.openGranted(win, folder));
          });
        },
        openRepository: () => {
          openExternally(REPOSITORY_URL);
        },
        command: (id) => {
          const win =
            BrowserWindow.getFocusedWindow() ??
            BrowserWindow.getAllWindows()[0];
          if (win !== undefined && !win.isDestroyed()) {
            win.webContents.send(EVENTS.menuCommand, id);
          }
        },
      }),
    );
  };
  const projects = new Projects({
    roots,
    recent,
    sessionFor,
    onRecentChanged: refreshMenu,
  });
  refreshMenu();

  const handle = createRouter(
    ipcMain,
    (event) =>
      sessions.has(event.sender)
        ? (BrowserWindow.fromWebContents(event.sender) ?? undefined)
        : undefined,
    devOrigin,
  );
  registerRoutes(
    handle,
    projects,
    sessionFor,
    (win, x, y) => {
      Menu.getApplicationMenu()?.popup({ window: win, x, y });
    },
    {
      store: settings,
      // Main's own dialog, so the renderer alone cannot raise a limit.
      confirmRaises: async (win, raises) => {
        const { response } = await dialog.showMessageBox(win, {
          type: "question",
          buttons: ["Cancel", "Allow"],
          defaultId: 0,
          cancelId: 0,
          message: "Let Epoch spend more on model features?",
          detail: raises.join("\n"),
        });
        return response === 1;
      },
    },
  );

  await openWindow(stateFile);
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) void openWindow(stateFile);
  });
}

// Not a top-level await: Electron emits "ready" only after the ESM main
// module has finished evaluating, so awaiting it here would never resolve
// (verified on Electron 43.7.7).
app.whenReady().then(start, (error: unknown) => {
  console.error(error);
  app.exit(1);
});
