import {
  contextBridge,
  ipcRenderer,
  webUtils,
  type IpcRendererEvent,
} from "electron";
import type { Graph, Progress, ProjectInfo } from "@epoch-dev/core";
import type { DesktopBridge } from "@epoch-dev/ui/bridge";
import { CHANNELS, EVENTS } from "../shared/channels";

/*
 * The sandboxed preload: the only code with access to ipcRenderer. It exposes
 * a fixed set of named functions as window.epoch, never ipcRenderer or a
 * generic send/invoke (CLAUDE.md "Electron security"). Main validates every
 * payload and checks the sender; nothing here is trusted by main.
 */

function invoke<T>(channel: string, ...args: unknown[]): Promise<T> {
  return ipcRenderer.invoke(channel, ...args) as Promise<T>;
}

const bridge: DesktopBridge = {
  openProject: (folder) => invoke<ProjectInfo>(CHANNELS.openProject, folder),
  getGraph: () => invoke<Graph>(CHANNELS.getGraph),
  onProgress: (cb) => {
    const listener = (_event: IpcRendererEvent, progress: Progress) => {
      cb(progress);
    };
    ipcRenderer.on(EVENTS.progress, listener);
    return () => {
      ipcRenderer.removeListener(EVENTS.progress, listener);
    };
  },
  chooseProject: () => invoke<ProjectInfo | null>(CHANNELS.chooseProject),
  // The path comes from Electron, not from page script: a File the page
  // constructs itself has no path, and main refuses the empty string.
  openDroppedFolder: (file) => {
    let folder: string;
    try {
      folder = webUtils.getPathForFile(file);
    } catch {
      folder = "";
    }
    return invoke<ProjectInfo>(CHANNELS.openDroppedFolder, folder);
  },
  recentProjects: () => invoke<string[]>(CHANNELS.recentProjects),
};

contextBridge.exposeInMainWorld("epoch", bridge);
