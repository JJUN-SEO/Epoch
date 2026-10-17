import {
  applyDelta,
  blastRadius,
  filterFindings,
  type AnalysisInfo,
  type EpochApi,
  type Graph,
  type ProjectInfo,
  type Settings,
  type WatchStatus,
} from "@epoch-dev/core";
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
  /** The file watcher's state. */
  onWatchStatus(cb: (status: WatchStatus) => void): () => void;
  /** What the latest analysis used (git history, coverage); null before it ends. */
  getAnalysisInfo(): Promise<AnalysisInfo | null>;
  onAnalysisInfo(cb: (info: AnalysisInfo) => void): () => void;
  /** The settings changed, in this window or another. */
  onSettingsChanged(cb: (settings: Settings) => void): () => void;
}

const unavailable = (what: string) => (): Promise<never> =>
  Promise.reject(new Error(`${what}.`));

/** The desktop app's EpochApi over the preload bridge (CLAUDE.md "Architecture"). */
export function createIpcApi(bridge: DesktopBridge): {
  api: EpochApi;
  shell: Shell;
} {
  // The latest graph, kept current with the watcher's deltas, so blast
  // radius runs here (core's pure function) without fetching the graph again.
  let current: Graph | undefined;
  bridge.onGraphDelta((d) => {
    if (current) current = applyDelta(current, d);
  });
  const graph = async (): Promise<Graph> => {
    current = await bridge.getGraph();
    return current;
  };
  return {
    api: {
      openProject: (folder) => {
        current = undefined;
        return bridge.openProject(folder);
      },
      getGraph: graph,
      getBlastRadius: async (nodeId, opts) =>
        blastRadius(current ?? (await graph()), nodeId, opts),
      onProgress: (cb) => bridge.onProgress(cb),
      onGraphDelta: (cb) => bridge.onGraphDelta(cb),
      getFindings: (filter) => bridge.getFindings(filter),
      dismissFinding: (id, note) => bridge.dismissFinding(id, note),
      undismissFinding: (id) => bridge.undismissFinding(id),
      getCodePreview: (file, start, end) =>
        bridge.getCodePreview(file, start, end),
      getSettings: () => bridge.getSettings(),
      updateSettings: (patch) => bridge.updateSettings(patch),
      setKey: (provider, value) => bridge.setKey(provider, value),
      removeKey: (provider) => bridge.removeKey(provider),
      getKeyStatus: (provider) => bridge.getKeyStatus(provider),
      getSummary: (subject, opts) => bridge.getSummary(subject, opts),
      generateSummary: (planId) => bridge.generateSummary(planId),
      cancelSummaries: () => bridge.cancelSummaries(),
      onSummaryProgress: (cb) => bridge.onSummaryProgress(cb),
      getSpend: () => bridge.getSpend(),
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
      onWatchStatus: (cb) => bridge.onWatchStatus(cb),
      getAnalysisInfo: () => bridge.getAnalysisInfo(),
      onAnalysisInfo: (cb) => bridge.onAnalysisInfo(cb),
      onSettingsChanged: (cb) => bridge.onSettingsChanged(cb),
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
    getBlastRadius: (nodeId, opts) =>
      Promise.resolve(blastRadius(graph, nodeId, opts)),
    getFindings: (filter) =>
      Promise.resolve(filterFindings(graph.findings, filter)),
    dismissFinding: unavailable("The demo cannot dismiss findings"),
    undismissFinding: unavailable("The demo cannot dismiss findings"),
    getCodePreview: unavailable("The demo includes no source code"),
    getSettings: unavailable("The demo has no settings"),
    updateSettings: unavailable("The demo has no settings"),
    setKey: unavailable("The demo has no model features"),
    removeKey: unavailable("The demo has no model features"),
    getKeyStatus: unavailable("The demo has no model features"),
    getSummary: unavailable("The demo has no model features"),
    generateSummary: unavailable("The demo has no model features"),
    cancelSummaries: () => Promise.resolve(),
    onSummaryProgress: () => () => undefined,
    getSpend: unavailable("The demo has no model features"),
  };
}
