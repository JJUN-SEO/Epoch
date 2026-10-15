import path from "node:path";
import type { BrowserWindow } from "electron";
import { z } from "zod";
import { Confidence, FindingKind } from "@epoch-dev/core";
import { DismissalId, DismissalNote } from "@epoch-dev/engine/dismissals";
import { CHANNELS } from "../shared/channels";
import { MAX_PREVIEW_LINES, RepoRelativePath } from "../shared/host-protocol";
import type { Register } from "./ipc";
import type { ProjectSession } from "./project";
import type { Projects } from "./projects";

/** An absolute path as the renderer may send it. Granting is checked separately. */
const FolderPath = z
  .string()
  .min(1)
  .max(4096)
  .refine((p) => path.isAbsolute(p), "must be an absolute path");

const FindingFilter = z.strictObject({
  kinds: z.array(FindingKind).max(3).exactOptional(),
  minConfidence: Confidence.exactOptional(),
  includeDismissed: z.boolean().exactOptional(),
});

const Line = z.number().int().min(1).max(10_000_000);

/** A preview range: file, start and end line, at most MAX_PREVIEW_LINES long. */
const PreviewArgs = z
  .tuple([RepoRelativePath, Line, Line])
  .refine(
    ([, start, end]) => end >= start && end - start < MAX_PREVIEW_LINES,
    `a range of 1 to ${String(MAX_PREVIEW_LINES)} lines`,
  );

/** A position in the window, in CSS pixels. */
const WindowCoordinate = z.number().int().min(0).max(100_000);

/** Registers every IPC channel main answers, each with its payload schema. */
export function registerRoutes(
  handle: Register,
  projects: Projects,
  sessionFor: (win: BrowserWindow) => ProjectSession,
  popupAppMenu: (win: BrowserWindow, x: number, y: number) => void,
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
  handle(CHANNELS.getAnalysisInfo, {
    args: z.tuple([]),
    handle: (win) => Promise.resolve(sessionFor(win).analysisInfo()),
  });
  handle(CHANNELS.getFindings, {
    args: z.tuple([FindingFilter.optional()]),
    handle: (win, filter?: z.infer<typeof FindingFilter>) =>
      sessionFor(win).findings(filter ?? {}),
  });
  handle(CHANNELS.dismissFinding, {
    args: z.tuple([DismissalId, DismissalNote.optional()]),
    handle: (win, id: string, note?: string) => {
      sessionFor(win).dismiss(id, note);
      return Promise.resolve(undefined);
    },
  });
  handle(CHANNELS.undismissFinding, {
    args: z.tuple([DismissalId]),
    handle: (win, id) => {
      sessionFor(win).undismiss(id);
      return Promise.resolve(undefined);
    },
  });
  handle(CHANNELS.getCodePreview, {
    args: PreviewArgs,
    handle: (win, file, start, end) =>
      sessionFor(win).preview(file, start, end),
  });
  handle(CHANNELS.showAppMenu, {
    args: z.tuple([WindowCoordinate, WindowCoordinate]),
    handle: (win, x, y) => {
      popupAppMenu(win, x, y);
      return Promise.resolve(undefined);
    },
  });
}
