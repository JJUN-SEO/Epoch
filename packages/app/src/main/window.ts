import { BrowserWindow, nativeTheme } from "electron";

export interface WindowOptions {
  /** URL of the UI: the app origin when built, the dev server in development. */
  readonly url: string;
  readonly preload?: string;
}

/**
 * The project window. The webPreferences below are fixed by CLAUDE.md
 * "Electron security" and must never be relaxed; the e2e suite reads them back
 * from the running app.
 */
export async function createProjectWindow(
  options: WindowOptions,
): Promise<BrowserWindow> {
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
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
  await win.loadURL(options.url);
  return win;
}
