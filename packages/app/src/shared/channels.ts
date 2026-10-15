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
} as const;

/** Main-to-renderer events. */
export const EVENTS = {
  progress: "epoch:progress",
} as const;
