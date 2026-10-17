import type {
  AnalysisInfo,
  CodePreview,
  Finding,
  FindingFilter,
  Graph,
  GraphDelta,
  KeyStatus,
  Progress,
  ProjectInfo,
  Settings,
  SettingsPatch,
  SpendStatus,
  SummaryProgress,
  SummaryState,
  Unsubscribe,
  WatchStatus,
} from "@epoch-dev/core";

/**
 * What the desktop app's preload script exposes as `window.epoch`: the M3
 * subset of EpochApi over IPC, plus the shell functions that grant access to
 * a folder (native dialog, drag-and-drop, recent list). The static demo site
 * has no bridge; it uses a static EpochApi instead.
 */
export interface DesktopBridge {
  /** Opens a folder the user already granted (a recent project). */
  openProject(path: string): Promise<ProjectInfo>;
  /** The graph of the open project, once its analysis finishes. */
  getGraph(): Promise<Graph>;
  onProgress(cb: (p: Progress) => void): Unsubscribe;
  /** The file watcher changed the graph (already applied in main). */
  onGraphDelta(cb: (d: GraphDelta) => void): Unsubscribe;
  onWatchStatus(cb: (s: WatchStatus) => void): Unsubscribe;
  /** The open project's findings; dismissed ones only when asked. */
  getFindings(filter?: FindingFilter): Promise<Finding[]>;
  /** Kept in Epoch's own data directory, never in the project. */
  dismissFinding(id: string, note?: string): Promise<void>;
  undismissFinding(id: string): Promise<void>;
  /** Read-only lines of a file inside the open project (repo-relative path). */
  getCodePreview(
    file: string,
    startLine: number,
    endLine: number,
  ): Promise<CodePreview>;
  /** What the latest analysis used; null until it finishes. */
  getAnalysisInfo(): Promise<AnalysisInfo | null>;
  onAnalysisInfo(cb: (info: AnalysisInfo) => void): Unsubscribe;
  /** Shows the native folder dialog; null when the user cancels. */
  chooseProject(): Promise<ProjectInfo | null>;
  /** A folder dropped on the window. Only real drops carry a path. */
  openDroppedFolder(file: File): Promise<ProjectInfo>;
  recentProjects(): Promise<string[]>;
  /** A project opened from the native menu (File > Open Project…). */
  onProjectOpened(cb: (project: ProjectInfo) => void): Unsubscribe;
  /**
   * Pops up the native application menu at a window position. Windows and
   * Linux use it: their custom title bar has no menu bar.
   */
  showAppMenu(x: number, y: number): Promise<void>;
  /** A command chosen in the native menu, such as "view.graph". */
  onMenuCommand(cb: (id: string) => void): Unsubscribe;
  getSettings(): Promise<Settings>;
  /** Raising what Epoch may spend asks in a native dialog; refused, it rejects. */
  updateSettings(patch: SettingsPatch): Promise<Settings>;
  /** The settings changed, in this window or another. */
  onSettingsChanged(cb: (settings: Settings) => void): Unsubscribe;
  /** Sends a key once to main; it is never readable back. */
  setKey(provider: string, value: string): Promise<void>;
  removeKey(provider: string): Promise<void>;
  getKeyStatus(provider: string): Promise<KeyStatus>;
  getSummary(subject: string, opts?: { auto?: boolean }): Promise<SummaryState>;
  generateSummary(planId: string): Promise<SummaryState>;
  cancelSummaries(): Promise<void>;
  onSummaryProgress(cb: (p: SummaryProgress) => void): Unsubscribe;
  getSpend(): Promise<SpendStatus>;
}
