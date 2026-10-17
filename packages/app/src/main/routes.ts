import path from "node:path";
import type { BrowserWindow } from "electron";
import { z } from "zod";
import { Confidence, FindingKind, SettingsPatch } from "@epoch-dev/core";
import { DismissalId, DismissalNote } from "@epoch-dev/engine/dismissals";
import { CHANNELS } from "../shared/channels";
import {
  MAX_PREVIEW_LINES,
  RepoRelativePath,
  SummarySubject,
} from "../shared/host-protocol";
import type { Register } from "./ipc";
import type { ProjectSession } from "./project";
import type { SqliteCacheStore } from "@epoch-dev/engine/cache";
import type { KeyStore } from "./key-store";
import type { Projects } from "./projects";
import type { SettingsStore } from "./settings-store";
import type { SummaryContext, SummaryService } from "./summary-service";

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

/** A model provider whose key the user can set (Jev is CLI-only: the app has no relation scorer, ADR-017). */
const Provider = z.enum(["anthropic"], { error: "unknown provider" });

/**
 * A key as the renderer may send it. Rejected without repeating it: the
 * error names the rule, never the value.
 */
const KeyValue = z
  .string({ error: "not a valid key" })
  .min(1, { error: "not a valid key" })
  .max(512, { error: "not a valid key" })
  // eslint-disable-next-line no-control-regex -- control characters are what this rejects
  .regex(/^[^\s\u0000-\u001f\u007f]+$/, { error: "not a valid key" });

/** A position in the window, in CSS pixels. */
const WindowCoordinate = z.number().int().min(0).max(100_000);

/** The settings, the keys, and main's native dialogs for both. */
export interface SettingsRoutes {
  readonly store: SettingsStore;
  readonly confirmRaises: (
    win: BrowserWindow,
    raises: readonly string[],
  ) => Promise<boolean>;
  readonly keys: KeyStore;
  /**
   * Linux without a keyring: keep the key for this session, store it with
   * weak protection, or cancel (undefined).
   */
  readonly chooseWeakStorage: (
    win: BrowserWindow,
  ) => Promise<"store" | "session" | undefined>;
  readonly summaries: SummaryService;
  /** Main's own dialog before this month's spending starts over. */
  readonly confirmResetSpend: (win: BrowserWindow) => Promise<boolean>;
  /** The shared cache (main's own connection; the host has another). */
  readonly cache: () => SqliteCacheStore;
  /** The window's open project as a summary context; undefined when none is open. */
  readonly summaryContext: (win: BrowserWindow) => SummaryContext | undefined;
}

/** Registers every IPC channel main answers, each with its payload schema. */
export function registerRoutes(
  handle: Register,
  projects: Projects,
  sessionFor: (win: BrowserWindow) => ProjectSession,
  popupAppMenu: (win: BrowserWindow, x: number, y: number) => void,
  settings: SettingsRoutes,
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
  handle(CHANNELS.getSettings, {
    args: z.tuple([]),
    handle: () => Promise.resolve(settings.store.get()),
  });
  handle(CHANNELS.updateSettings, {
    args: z.tuple([SettingsPatch]),
    handle: (win, patch) =>
      settings.store.update(patch, (raises) =>
        settings.confirmRaises(win, raises),
      ),
  });
  handle(CHANNELS.setKey, {
    args: z.tuple([Provider, KeyValue]),
    handle: async (win, provider, value) => {
      let mode: "store" | "session" | undefined = "store";
      if ((await settings.keys.protection()) === "weak")
        mode = await settings.chooseWeakStorage(win);
      if (mode === undefined) throw new Error("The key was not saved.");
      await settings.keys.set(provider, value, mode);
      // Saving a key is the opt-in: summaries turn on with it, using the
      // key's provider (ADR-016). The first send per project still asks.
      if (!settings.store.get().summaries.enabled)
        await settings.store.update(
          { summaries: { enabled: true, provider } },
          (raises) => settings.confirmRaises(win, raises),
        );
      return undefined;
    },
  });
  handle(CHANNELS.removeKey, {
    args: z.tuple([Provider]),
    handle: async (_win, provider) => {
      await settings.keys.remove(provider);
      return undefined;
    },
  });
  handle(CHANNELS.getKeyStatus, {
    args: z.tuple([Provider]),
    handle: (_win, provider) => settings.keys.status(provider),
  });
  handle(CHANNELS.getSummary, {
    args: z.tuple([
      SummarySubject,
      z.strictObject({ auto: z.boolean().exactOptional() }).optional(),
    ]),
    handle: (win, subject, opts?: { auto?: boolean }) => {
      const ctx = settings.summaryContext(win);
      if (!ctx)
        return Promise.resolve({
          state: "unavailable",
          subject,
          reason: "no-project",
        });
      return settings.summaries.get(ctx, subject, opts ?? {});
    },
  });
  handle(CHANNELS.generateSummary, {
    args: z.tuple([z.uuid()]),
    handle: (win, planId) => {
      const ctx = settings.summaryContext(win);
      if (!ctx)
        return Promise.resolve({
          state: "failed",
          subject: "",
          reason: "expired",
        });
      return settings.summaries.generate(ctx, planId);
    },
  });
  handle(CHANNELS.cancelSummaries, {
    args: z.tuple([]),
    handle: async (win) => {
      const ctx = settings.summaryContext(win);
      if (ctx) await settings.summaries.cancel(ctx);
      return undefined;
    },
  });
  handle(CHANNELS.getSpend, {
    args: z.tuple([]),
    handle: () => Promise.resolve(settings.summaries.spend()),
  });
  handle(CHANNELS.resetSpend, {
    args: z.tuple([]),
    handle: async (win) => {
      if (await settings.confirmResetSpend(win))
        settings.summaries.resetSpend();
      return settings.summaries.spend();
    },
  });
  handle(CHANNELS.getCacheStats, {
    args: z.tuple([]),
    handle: () => {
      const s = settings.cache().stats();
      return Promise.resolve({
        bytes: s.bytes,
        facts: s.facts,
        derived: s.derived,
        summaries: s.summaries,
      });
    },
  });
  handle(CHANNELS.clearCache, {
    args: z.tuple([]),
    handle: () => {
      const cache = settings.cache();
      cache.clear();
      const s = cache.stats();
      return Promise.resolve({
        bytes: s.bytes,
        facts: s.facts,
        derived: s.derived,
        summaries: s.summaries,
      });
    },
  });
  handle(CHANNELS.showAppMenu, {
    args: z.tuple([WindowCoordinate, WindowCoordinate]),
    handle: (win, x, y) => {
      popupAppMenu(win, x, y);
      return Promise.resolve(undefined);
    },
  });
}
