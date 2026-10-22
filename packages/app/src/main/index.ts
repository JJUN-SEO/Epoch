import path from "node:path";
import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  safeStorage,
  screen,
  session,
  type WebContents,
} from "electron";
import {
  PROVIDER_INFO,
  isRemoteProvider,
  updateChecksAllowed,
  type ProjectInfo,
} from "@epoch-dev/core";
import { installTripwire } from "@epoch-dev/scorers/tripwire";
import { EVENTS } from "../shared/channels";
import { hardenSession, hardenWebContents, openExternally } from "./harden";
import { HostClient } from "./host-client";
import { createRouter } from "./ipc";
import { openCache, type SqliteCacheStore } from "@epoch-dev/engine/cache";
import { KeyStore } from "./key-store";
import { buildMenu } from "./menu";
import { embeddingModelDir, hostModelArgs } from "./model";
import { APP_ENTRY_URL, devServerOrigin } from "./policy";
import { ProjectSession } from "./project";
import { Projects } from "./projects";
import { registerAppScheme, serveUi } from "./protocol";
import { RecentProjects } from "./recent";
import { REPOSITORY_URL } from "./release";
import { GrantedRoots } from "./roots";
import { registerRoutes } from "./routes";
import { ConsentStore } from "./consent-store";
import { SettingsStore } from "./settings-store";
import { SpendLedger } from "./spend-ledger";
import { SummaryService, type SenderLike } from "./summary-service";
import { UpdateChecker } from "./update-check";
import { UpdateStore } from "./update-store";
import type { Egress } from "./egress";
import { createProjectWindow } from "./window";
import { isReachable, loadWindowState, saveWindowState } from "./window-state";

// Main sends only through its egress, an Electron session (ADR-016): Node's
// own sockets, DNS and fetch are never used here, so any attempt is refused.
installTripwire({
  onAttempt: (name) => {
    console.error(`[epoch] main tried to use the network (${name}); refused`);
  },
});

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
  const keys = new KeyStore(
    path.join(userData, "keys.json"),
    safeStorage,
    process.platform,
  );
  // Main's one way out (ADR-016), created when something first sends: a
  // summary, or (ADR-018) the update check. One session, one request filter.
  let egress: Promise<Egress> | undefined;
  const getEgress = () =>
    (egress ??= import("./egress").then((m) =>
      m.createEgress(() => settings.get().offline),
    ));
  let sender: Promise<SenderLike> | undefined;
  let cache: SqliteCacheStore | undefined;
  app.on("will-quit", () => {
    cache?.close();
  });
  const summaries = new SummaryService({
    settings: () => settings.get(),
    keys,
    ledger: new SpendLedger(path.join(userData, "spend.json")),
    consent: new ConsentStore(path.join(userData, "consent.json")),
    // Main's own dialog, so the renderer alone can never approve a send.
    askConsent: async (ctx, plan) => {
      const win = BrowserWindow.getAllWindows().find(
        (w) => w.webContents.id === ctx.windowId,
      );
      if (!win) return false;
      const listed = plan.sends.slice(0, 12).join("\n");
      const more = Math.max(0, plan.sends.length - 12) + plan.sendsMore;
      const { response } = await dialog.showMessageBox(win, {
        type: "question",
        buttons: ["Cancel", "Send"],
        defaultId: 0,
        cancelId: 0,
        message: `Send code from ${path.basename(ctx.root)} to ${
          isRemoteProvider(plan.provider)
            ? PROVIDER_INFO[plan.provider].label
            : plan.destination
        }?`,
        detail: [
          `To write summaries, Epoch will send the content of these files to ${plan.destination} with your key (model ${plan.model}):`,
          listed + (more > 0 ? `\n…and ${String(more)} more` : ""),
          plan.excluded.length > 0
            ? `Never sent (they look like secrets): ${plan.excluded.join(", ")}`
            : "",
          // From Google's pricing page: its free tier may use content to
          // improve its products, its paid tier does not (ADR-019).
          plan.provider === "gemini"
            ? "With a free-tier Gemini key, Google may use what is sent to improve its products; with a paid-tier key it does not."
            : "",
          `At most $${plan.estimate.worstCaseUsd.toFixed(4)} at your prices. This applies to this project only; summaries can be turned off in Settings.`,
        ]
          .filter((l) => l !== "")
          .join("\n\n"),
      });
      return response === 1;
    },
    // The model client, in a lazy chunk, loaded when a summary is first sent.
    sender: () =>
      (sender ??= Promise.all([import("./sender"), getEgress()]).then(
        ([m, out]) => m.createSender(out),
      )),
  });
  let previous = settings.get();
  settings.onChange((next) => {
    summaries.settingsChanged(previous, next);
    previous = next;
  });
  settings.onChange((next) => {
    for (const win of BrowserWindow.getAllWindows())
      if (!win.isDestroyed())
        win.webContents.send(EVENTS.settingsChanged, next);
  });

  // The update check (ADR-018): at most once a day, one GET to the release
  // host through the egress; a newer release becomes a notice in the window.
  // Never with update checks off or in offline mode.
  const updates = new UpdateChecker({
    now: () => Date.now(),
    allowed: () => updateChecksAllowed(settings.get()),
    currentVersion: app.getVersion(),
    latestTag: async () => (await getEgress()).latestReleaseTag(),
    abort: () => {
      void egress?.then((out) => {
        out.abortUpdateCheck();
      });
    },
    store: new UpdateStore(path.join(userData, "update-check.json")),
    notify: (update) => {
      for (const win of BrowserWindow.getAllWindows())
        if (!win.isDestroyed())
          win.webContents.send(EVENTS.updateAvailable, update);
    },
  });
  let checksAllowed = updateChecksAllowed(settings.get());
  settings.onChange((next) => {
    const was = checksAllowed;
    checksAllowed = updateChecksAllowed(next);
    updates.settingsChanged(was);
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
      keys,
      chooseWeakStorage: async (win) => {
        const { response } = await dialog.showMessageBox(win, {
          type: "warning",
          buttons: ["This session only", "Store anyway (weak)", "Cancel"],
          defaultId: 0,
          cancelId: 2,
          message: "This system has no keyring to protect your key.",
          detail:
            "Epoch can keep the key until it quits, or store it with weak protection that other programs running as you could read.",
        });
        return response === 0
          ? "session"
          : response === 1
            ? "store"
            : undefined;
      },
      summaries,
      confirmResetSpend: async (win) => {
        const { response } = await dialog.showMessageBox(win, {
          type: "question",
          buttons: ["Cancel", "Reset"],
          defaultId: 0,
          cancelId: 0,
          message: "Start this month's spending over?",
          detail:
            "Epoch may then spend up to your monthly cap again. What was already spent at the provider stays spent.",
        });
        return response === 1;
      },
      cache: () => (cache ??= openCache()),
      updateStatus: () => updates.status(),
      summaryContext: (win) => {
        const target = sessions.get(win.webContents)?.summaryTarget();
        if (!target) return undefined;
        const contents = win.webContents;
        return {
          windowId: contents.id,
          root: target.root,
          host: target.host,
          notify: (progress) => {
            if (!contents.isDestroyed())
              contents.send(EVENTS.summaryProgress, progress);
          },
        };
      },
    },
  );

  await openWindow(stateFile);
  // The first check waits until the window has settled; later ticks ask
  // only once the last answer is a day old.
  const firstCheck = setTimeout(() => void updates.tick(), 10_000);
  const hourly = setInterval(() => void updates.tick(), 60 * 60 * 1000);
  app.on("will-quit", () => {
    clearTimeout(firstCheck);
    clearInterval(hourly);
  });
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
