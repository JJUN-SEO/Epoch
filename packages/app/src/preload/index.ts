import {
  contextBridge,
  ipcRenderer,
  webUtils,
  type IpcRendererEvent,
} from "electron";
import type {
  AnalysisInfo,
  CodePreview,
  Finding,
  Graph,
  KeyStatus,
  Progress,
  ProjectInfo,
  Settings,
} from "@epoch-dev/core";
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

/**
 * Subscribes to one main-to-renderer event; returns the unsubscribe function.
 * Main sends each event's payload type (shared/channels.ts).
 */
function on(event: string, cb: (payload: never) => void): () => void {
  const listener = (_event: IpcRendererEvent, payload: unknown) => {
    cb(payload as never);
  };
  ipcRenderer.on(event, listener);
  return () => {
    ipcRenderer.removeListener(event, listener);
  };
}

const bridge: DesktopBridge = {
  openProject: (folder) => invoke<ProjectInfo>(CHANNELS.openProject, folder),
  getGraph: () => invoke<Graph>(CHANNELS.getGraph),
  onGraphDelta: (cb) => on(EVENTS.graphDelta, cb),
  onWatchStatus: (cb) => on(EVENTS.watchStatus, cb),
  getFindings: (filter) =>
    filter === undefined
      ? invoke<Finding[]>(CHANNELS.getFindings)
      : invoke<Finding[]>(CHANNELS.getFindings, filter),
  dismissFinding: (id, note) =>
    note === undefined
      ? invoke<undefined>(CHANNELS.dismissFinding, id)
      : invoke<undefined>(CHANNELS.dismissFinding, id, note),
  undismissFinding: (id) => invoke<undefined>(CHANNELS.undismissFinding, id),
  getCodePreview: (file, startLine, endLine) =>
    invoke<CodePreview>(CHANNELS.getCodePreview, file, startLine, endLine),
  getAnalysisInfo: () => invoke<AnalysisInfo | null>(CHANNELS.getAnalysisInfo),
  onAnalysisInfo: (cb) => on(EVENTS.analysisInfo, cb),
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
  onProjectOpened: (cb) => {
    const listener = (_event: IpcRendererEvent, project: ProjectInfo) => {
      cb(project);
    };
    ipcRenderer.on(EVENTS.projectOpened, listener);
    return () => {
      ipcRenderer.removeListener(EVENTS.projectOpened, listener);
    };
  },
  showAppMenu: (x, y) => invoke<undefined>(CHANNELS.showAppMenu, x, y),
  getSettings: () => invoke<Settings>(CHANNELS.getSettings),
  updateSettings: (patch) => invoke<Settings>(CHANNELS.updateSettings, patch),
  onSettingsChanged: (cb) => on(EVENTS.settingsChanged, cb),
  setKey: (provider, value) =>
    invoke<undefined>(CHANNELS.setKey, provider, value),
  removeKey: (provider) => invoke<undefined>(CHANNELS.removeKey, provider),
  getKeyStatus: (provider) =>
    invoke<KeyStatus>(CHANNELS.getKeyStatus, provider),
  onMenuCommand: (cb) => {
    const listener = (_event: IpcRendererEvent, id: string) => {
      cb(id);
    };
    ipcRenderer.on(EVENTS.menuCommand, listener);
    return () => {
      ipcRenderer.removeListener(EVENTS.menuCommand, listener);
    };
  },
};

contextBridge.exposeInMainWorld("epoch", bridge);
