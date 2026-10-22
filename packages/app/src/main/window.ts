import { BrowserWindow, nativeTheme } from "electron";

export interface WindowOptions {
  readonly preload?: string;
  /** Saved size and position, already checked to be on a display. */
  readonly bounds?: {
    readonly x: number;
    readonly y: number;
    readonly width: number;
    readonly height: number;
  };
}

/** The UI's title bar height (packages/ui/src/styles.css, .titlebar). */
export const TITLE_BAR_HEIGHT = 40;

/** Window colors matching the UI's design tokens (styles.css), per theme. */
export function chromeColors(dark: boolean): {
  readonly background: string;
  readonly overlay: string;
  readonly symbols: string;
} {
  return dark
    ? { background: "#121215", overlay: "#1a1a1e", symbols: "#ececf1" }
    : { background: "#ffffff", overlay: "#f4f4f6", symbols: "#1c1c21" };
}

/**
 * The project window, not yet loaded (the caller registers it first, so the
 * UI's first IPC call already comes from a known window). The webPreferences
 * below are fixed by CLAUDE.md "Electron security" and must never be relaxed;
 * the e2e suite reads them back from the running app.
 *
 * The UI draws its own title bar. macOS keeps its traffic lights, inset into
 * that bar; Windows and Linux keep their native window buttons through the
 * Window Controls Overlay, colored to match the theme. Options from Electron
 * 43.7.7's BrowserWindowConstructorOptions (titleBarStyle, titleBarOverlay).
 */
export function createProjectWindow(options: WindowOptions): BrowserWindow {
  const mac = process.platform === "darwin";
  const colors = chromeColors(nativeTheme.shouldUseDarkColors);
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    ...options.bounds,
    minWidth: 720,
    minHeight: 480,
    show: false,
    title: "Epoch",
    backgroundColor: colors.background,
    ...(mac
      ? { titleBarStyle: "hiddenInset" as const }
      : {
          titleBarStyle: "hidden" as const,
          titleBarOverlay: {
            color: colors.overlay,
            symbolColor: colors.symbols,
            height: TITLE_BAR_HEIGHT,
          },
        }),
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      nodeIntegrationInWorker: false,
      nodeIntegrationInSubFrames: false,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      webviewTag: false,
      navigateOnDragDrop: false,
      spellcheck: false,
      ...(options.preload === undefined ? {} : { preload: options.preload }),
    },
  });

  // Follow the OS theme in the parts the UI cannot paint.
  const onTheme = () => {
    const next = chromeColors(nativeTheme.shouldUseDarkColors);
    win.setBackgroundColor(next.background);
    if (!mac) {
      win.setTitleBarOverlay({
        color: next.overlay,
        symbolColor: next.symbols,
        height: TITLE_BAR_HEIGHT,
      });
    }
  };
  nativeTheme.on("updated", onTheme);
  win.on("closed", () => {
    nativeTheme.off("updated", onTheme);
  });

  // A desktop app does not pinch-zoom its whole window; the View menu's zoom
  // items still scale the UI.
  win.webContents.on("did-finish-load", () => {
    void win.webContents.setVisualZoomLevelLimits(1, 1);
  });

  win.once("ready-to-show", () => {
    win.show();
  });
  return win;
}
