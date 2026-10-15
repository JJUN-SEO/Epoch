import type {
  Graph,
  Progress,
  ProjectInfo,
  Unsubscribe,
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
  /** Shows the native folder dialog; null when the user cancels. */
  chooseProject(): Promise<ProjectInfo | null>;
  /** A folder dropped on the window. Only real drops carry a path. */
  openDroppedFolder(file: File): Promise<ProjectInfo>;
  recentProjects(): Promise<string[]>;
  /** A project opened from the native menu (File > Open Project…). */
  onProjectOpened(cb: (project: ProjectInfo) => void): Unsubscribe;
}
