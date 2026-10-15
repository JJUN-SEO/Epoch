import type { EpochApi, Graph, ProjectInfo } from "@epoch-dev/core";
import type { DesktopBridge } from "./bridge";

/**
 * App-only functions that grant access to a folder. The static demo site has
 * no shell: it shows precomputed graphs and opens nothing.
 */
export interface Shell {
  chooseProject(): Promise<ProjectInfo | null>;
  openDroppedFolder(file: File): Promise<ProjectInfo>;
  recentProjects(): Promise<string[]>;
  /** Projects opened from the native menu. */
  onProjectOpened(cb: (project: ProjectInfo) => void): () => void;
  /** The native application menu, popped up from the title bar (Windows, Linux). */
  showAppMenu(x: number, y: number): void;
  /** Commands chosen in the native menu. */
  onMenuCommand(cb: (id: string) => void): () => void;
}

const unavailable = (what: string) => (): Promise<never> =>
  Promise.reject(new Error(`${what}.`));

/** EpochApi methods that later milestones implement. */
const later = {
  getBlastRadius: unavailable("Blast radius arrives in M4"),
  getFindings: unavailable("Findings arrive in M5"),
  dismissFinding: unavailable("Findings arrive in M5"),
  undismissFinding: unavailable("Findings arrive in M5"),
  getCodePreview: unavailable("Code preview arrives in M5"),
  getSettings: unavailable("Settings arrive in M7"),
  updateSettings: unavailable("Settings arrive in M7"),
  setKey: unavailable("Keys arrive in M7"),
  getKeyStatus: unavailable("Keys arrive in M7"),
};

/** The desktop app's EpochApi over the preload bridge (CLAUDE.md "Architecture"). */
export function createIpcApi(bridge: DesktopBridge): {
  api: EpochApi;
  shell: Shell;
} {
  return {
    api: {
      openProject: (folder) => bridge.openProject(folder),
      getGraph: () => bridge.getGraph(),
      onProgress: (cb) => bridge.onProgress(cb),
      // The file watcher arrives in M4; until then nothing changes a graph.
      onGraphDelta: () => () => undefined,
      ...later,
    },
    shell: {
      chooseProject: () => bridge.chooseProject(),
      openDroppedFolder: (file) => bridge.openDroppedFolder(file),
      recentProjects: () => bridge.recentProjects(),
      onProjectOpened: (cb) => bridge.onProjectOpened(cb),
      showAppMenu: (x, y) => {
        void bridge.showAppMenu(x, y);
      },
      onMenuCommand: (cb) => bridge.onMenuCommand(cb),
    },
  };
}

/**
 * The read-only EpochApi of the static demo site (M8): one precomputed graph,
 * no analysis, no source code, no model features.
 */
export function createStaticApi(project: ProjectInfo, graph: Graph): EpochApi {
  return {
    openProject: () => Promise.resolve(project),
    getGraph: () => Promise.resolve(graph),
    onProgress: () => () => undefined,
    onGraphDelta: () => () => undefined,
    ...later,
    getCodePreview: unavailable("The demo includes no source code"),
    getSettings: unavailable("The demo has no settings"),
    updateSettings: unavailable("The demo has no settings"),
    setKey: unavailable("The demo has no model features"),
    getKeyStatus: unavailable("The demo has no model features"),
  };
}
