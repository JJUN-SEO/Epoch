import path from "node:path";
import { dialog, type BrowserWindow } from "electron";
import { z } from "zod";
import type { ProjectInfo } from "@epoch-dev/core";
import { CHANNELS } from "../shared/channels";
import type { Register } from "./ipc";
import type { ProjectSession } from "./project";
import type { RecentProjects } from "./recent";
import { realFolder, type GrantedRoots } from "./roots";

/** An absolute path as the renderer may send it. Granting is checked separately. */
const FolderPath = z
  .string()
  .min(1)
  .max(4096)
  .refine((p) => path.isAbsolute(p), "must be an absolute path");

export interface RouteDeps {
  readonly roots: GrantedRoots;
  readonly recent: RecentProjects;
  readonly sessionFor: (win: BrowserWindow) => ProjectSession;
}

/** Registers every IPC channel main answers, each with its payload schema. */
export function registerRoutes(handle: Register, deps: RouteDeps): void {
  const open = (win: BrowserWindow, real: string): ProjectInfo => {
    const info = deps.sessionFor(win).open(real);
    deps.recent.add(real);
    win.setTitle(`${info.name} — Epoch`);
    return info;
  };

  handle(CHANNELS.openProject, {
    args: z.tuple([FolderPath]),
    handle: (win, folder) =>
      Promise.resolve(open(win, deps.roots.resolve(folder))),
  });
  handle(CHANNELS.openDroppedFolder, {
    // The preload read this path from a real drop (webUtils.getPathForFile).
    args: z.tuple([FolderPath]),
    handle: (win, folder) =>
      Promise.resolve(open(win, deps.roots.grant(folder))),
  });
  handle(CHANNELS.chooseProject, {
    args: z.tuple([]),
    handle: async (win) => {
      const choice = await dialog.showOpenDialog(win, {
        title: "Open Project",
        properties: ["openDirectory"],
      });
      const [folder] = choice.filePaths;
      if (choice.canceled || folder === undefined) return null;
      return open(win, deps.roots.grant(folder));
    },
  });
  handle(CHANNELS.recentProjects, {
    args: z.tuple([]),
    handle: () =>
      Promise.resolve(
        deps.recent.projects.filter((p) => {
          try {
            return realFolder(p) === p;
          } catch {
            return false;
          }
        }),
      ),
  });
  handle(CHANNELS.getGraph, {
    args: z.tuple([]),
    handle: (win) => deps.sessionFor(win).graph(),
  });
}
