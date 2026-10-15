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

/**
 * The project window, not yet loaded (the caller registers it first, so the
 * UI's first IPC call already comes from a known window). The webPreferences
 * below are fixed by CLAUDE.md "Electron security" and must never be relaxed;
 * the e2e suite reads them back from the running app.
 */
export function createProjectWindow(options: WindowOptions): BrowserWindow {
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    ...options.bounds,
    minWidth: 720,
    minHeight: 480,
    show: false,
    title: "Epoch",
    backgroundColor: nativeTheme.shouldUseDarkColors ? "#0b0d10" : "#ffffff",
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
  win.once("ready-to-show", () => {
    win.show();
  });
  return win;
}
