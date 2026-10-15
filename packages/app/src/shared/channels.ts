/*
 * The fixed IPC channel names between the preload and main. There are no
 * others, and the preload exposes no generic send or invoke (CLAUDE.md
 * "Electron security"). Payload schemas live in main/routes.ts, so the
 * sandboxed preload bundle stays free of zod.
 */
export const CHANNELS = {
  openProject: "epoch:open-project",
  openDroppedFolder: "epoch:open-dropped-folder",
  chooseProject: "epoch:choose-project",
  recentProjects: "epoch:recent-projects",
  getGraph: "epoch:get-graph",
  /** What the latest analysis used (git history, coverage report); no payload. */
  getAnalysisInfo: "epoch:get-analysis-info",
  /** Pops up the application menu (Windows, Linux: the title bar has no menu bar). */
  showAppMenu: "epoch:show-app-menu",
} as const;

/** Main-to-renderer events. */
export const EVENTS = {
  progress: "epoch:progress",
  /** The watcher changed the graph; payload: GraphDelta. */
  graphDelta: "epoch:graph-delta",
  /** The watcher's state; payload: WatchStatus. */
  watchStatus: "epoch:watch-status",
  /** What the latest analysis used; payload: AnalysisInfo. */
  analysisInfo: "epoch:analysis-info",
  /** A project opened from the native menu; payload: ProjectInfo. */
  projectOpened: "epoch:project-opened",
  /** A command chosen in the native menu; payload: one of MENU_COMMANDS. */
  menuCommand: "epoch:menu-command",
} as const;

/**
 * The renderer commands the native menu can send. The renderer ignores
 * anything else (packages/ui/src/shell/commands.ts lists the same ids).
 */
export const MENU_COMMANDS = [
  "palette",
  "view.graph",
  "view.focus",
  "nav.back",
  "nav.forward",
  "panel.sidebar",
  "panel.inspector",
] as const;
export type MenuCommand = (typeof MENU_COMMANDS)[number];
