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
  /** The open project's findings; payload: an optional FindingFilter. */
  getFindings: "epoch:get-findings",
  /** payload: finding id, optional note. */
  dismissFinding: "epoch:dismiss-finding",
  /** payload: finding id. */
  undismissFinding: "epoch:undismiss-finding",
  /** payload: repo-relative file, start line, end line. */
  getCodePreview: "epoch:get-code-preview",
  /** Pops up the application menu (Windows, Linux: the title bar has no menu bar). */
  showAppMenu: "epoch:show-app-menu",
  /** The app's settings; no payload. */
  getSettings: "epoch:get-settings",
  /** payload: a SettingsPatch; raising spend limits asks in a native dialog. */
  updateSettings: "epoch:update-settings",
  /** payload: provider, key. One-way: no channel returns a key. */
  setKey: "epoch:set-key",
  /** payload: provider. */
  removeKey: "epoch:remove-key",
  /** payload: provider; answers whether a key is set and how it is kept. */
  getKeyStatus: "epoch:get-key-status",
  /** payload: subject, optional { auto }; answers a SummaryState. */
  getSummary: "epoch:get-summary",
  /** payload: a plan id from a needs-approval state. */
  generateSummary: "epoch:generate-summary",
  /** Stops this window's summary requests; no payload. */
  cancelSummaries: "epoch:cancel-summaries",
  /** What model features spent; no payload. */
  getSpend: "epoch:get-spend",
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
  /** The settings changed (in any window); payload: Settings. */
  settingsChanged: "epoch:settings-changed",
  /** A summary job in this window advanced; payload: SummaryProgress. */
  summaryProgress: "epoch:summary-progress",
} as const;

/**
 * The renderer commands the native menu can send. The renderer ignores
 * anything else (packages/ui/src/shell/commands.ts lists the same ids).
 */
export const MENU_COMMANDS = [
  "palette",
  "view.graph",
  "view.focus",
  "view.findings",
  "nav.back",
  "nav.forward",
  "panel.sidebar",
  "panel.inspector",
] as const;
export type MenuCommand = (typeof MENU_COMMANDS)[number];
