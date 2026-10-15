import path from "node:path";
import type { BrowserWindow } from "electron";
import { z } from "zod";
import { CHANNELS } from "../shared/channels";
import type { Register } from "./ipc";
import type { ProjectSession } from "./project";
import type { Projects } from "./projects";

/** An absolute path as the renderer may send it. Granting is checked separately. */
const FolderPath = z
  .string()
  .min(1)
  .max(4096)
  .refine((p) => path.isAbsolute(p), "must be an absolute path");

/** Registers every IPC channel main answers, each with its payload schema. */
export function registerRoutes(
  handle: Register,
  projects: Projects,
  sessionFor: (win: BrowserWindow) => ProjectSession,
): void {
  handle(CHANNELS.openProject, {
    args: z.tuple([FolderPath]),
    handle: (win, folder) => Promise.resolve(projects.openGranted(win, folder)),
  });
  handle(CHANNELS.openDroppedFolder, {
    // The preload read this path from a real drop (webUtils.getPathForFile).
    args: z.tuple([FolderPath]),
    handle: (win, folder) => Promise.resolve(projects.openDropped(win, folder)),
  });
  handle(CHANNELS.chooseProject, {
    args: z.tuple([]),
    handle: (win) => projects.choose(win),
  });
  handle(CHANNELS.recentProjects, {
    args: z.tuple([]),
    handle: () => Promise.resolve(projects.recentProjects()),
  });
  handle(CHANNELS.getGraph, {
    args: z.tuple([]),
    handle: (win) => sessionFor(win).graph(),
  });
}
