import { z } from "zod";
import { AnalysisMeta, StoredSummary } from "@epoch-dev/core";

/*
 * Messages between main and the analysis host (a utilityProcess). Both sides
 * parse what they receive. A graph arrives already validated: the engine's
 * analyze() parses it with the Graph schema before returning it, so main does
 * not parse thousands of nodes a second time on its own thread. A delta is
 * the difference between two such graphs (core's diffGraphs), computed in
 * the host; main applies it with core's applyDelta.
 */

export const ProgressMessage = z.object({
  stage: z.enum(["discover", "parse", "resolve", "graph", "done"]),
  done: z.number().int().nonnegative(),
  total: z.number().int().nonnegative(),
});

/** What the analysis used: git history, coverage, config, findings checks and hint sources (AnalysisInfo). */
export const AnalysisInfoMessage = z.strictObject({
  git: AnalysisMeta.shape.git,
  coverage: AnalysisMeta.shape.coverage,
  config: AnalysisMeta.shape.config,
  findings: AnalysisMeta.shape.findings,
  hints: AnalysisMeta.shape.hints,
});

/** Lines a code preview may return at most (CodePreview). */
export const MAX_PREVIEW_LINES = 200;
/** Characters kept per previewed line; longer lines (minified code) are cut. */
export const MAX_PREVIEW_LINE_CHARS = 1000;

/**
 * A repo-relative file path as the renderer may send it: forward slashes, no
 * empty, "." or ".." segment, nothing absolute, no drive letter or backslash.
 * The host still reads only through the root-confined reader.
 */
export const RepoRelativePath = z
  .string()
  .min(1)
  .max(4096)
  .refine(
    (p) =>
      !p.includes("\\") &&
      !p.includes(":") &&
      !p.includes("\0") &&
      p.split("/").every((seg) => seg !== "" && seg !== "." && seg !== ".."),
    "must be a repo-relative path",
  );

/**
 * What a summary is about: a file (repo-relative), a Go package node
 * ("pkg:<import path>", looked up in the graph, never read as a path), or a
 * folder ("dir:<repo-relative path>", "dir:" for the project root).
 */
export const SummarySubject = z
  .string()
  .min(1)
  .max(4096)
  .refine((s) => {
    if (s.startsWith("dir:")) {
      const dir = s.slice(4);
      return dir === "" || RepoRelativePath.safeParse(dir).success;
    }
    if (s.startsWith("pkg:")) return /^[^\0\\]+$/.test(s.slice(4));
    return RepoRelativePath.safeParse(s).success;
  }, "must be a file, pkg: or dir: subject");

export const SummaryModelMessage = z.strictObject({
  provider: z.enum(["anthropic", "local"]),
  model: z.string().regex(/^[A-Za-z0-9._:/-]{1,200}$/),
});

/** A model's answer as main received it; the host sanitizes it before storing. */
const MAX_ANSWER_CHARS = 64 * 1024;

export const SummaryStatusMessage = z.discriminatedUnion("state", [
  z.strictObject({ state: z.literal("missing") }),
  z.strictObject({ state: z.literal("fresh"), summary: StoredSummary }),
  z.strictObject({
    state: z.literal("stale"),
    why: z.enum(["file", "dependencies"]),
    previous: StoredSummary,
  }),
]);

/** A summary plan as the host reports it (engine planSummary), without its forbidden lines. */
export const SummaryPlanMessage = z.discriminatedUnion("ok", [
  z.strictObject({
    ok: z.literal(true),
    subject: SummarySubject,
    kind: z.enum(["file", "package", "dir"]),
    key: z.string().regex(/^[0-9a-f]{64}$/),
    status: SummaryStatusMessage,
    /** Summaries given as input. */
    used: z.number().int().nonnegative(),
    truncated: z.boolean(),
    excluded: z.array(z.string()).max(10_000),
    /** Files whose content the prompt holds (a folder's holds none). */
    sends: z.array(z.string()).max(10_000),
    /** The prompt's size in tokens, estimated (scorers estimateTokens). */
    inputTokens: z.number().int().nonnegative(),
    /** Only when asked for: the text to send, source included. Main never stores or forwards it. */
    prompt: z.strictObject({ system: z.string(), user: z.string() }).optional(),
  }),
  z.strictObject({
    ok: z.literal(false),
    subject: SummarySubject,
    reason: z.enum([
      "not-in-graph",
      "secret",
      "unreadable",
      "empty",
      "children-missing",
      "no-project",
    ]),
    missing: z.array(z.string()).max(10_000).optional(),
  }),
]);
export type SummaryPlanMessage = z.infer<typeof SummaryPlanMessage>;

/** One subject of a folder job, as planned before it starts. */
export const SummaryJobItem = z.strictObject({
  subject: SummarySubject,
  /** fresh: nothing to do; todo: to summarize; skip: never (a secret, empty, unreadable). */
  state: z.enum(["fresh", "todo", "skip"]),
  /** Estimated; for a folder whose children are not summarized yet, its worst case. */
  inputTokens: z.number().int().nonnegative(),
  sends: z.array(z.string()).max(10_000),
  excluded: z.array(z.string()).max(10_000),
});
export type SummaryJobItem = z.infer<typeof SummaryJobItem>;

export const CodePreviewMessage = z.strictObject({
  file: z.string(),
  startLine: z.number().int().positive(),
  lines: z.array(z.string()).max(MAX_PREVIEW_LINES),
});

const StatusText = z.string().max(2000);

export const WatchStatusMessage = z.discriminatedUnion("state", [
  z.strictObject({ state: z.literal("watching") }),
  z.strictObject({ state: z.literal("updating") }),
  z.strictObject({ state: z.literal("error"), message: StatusText }),
  z.strictObject({ state: z.literal("stopped"), message: StatusText }),
]);

export const HostRequest = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("analyze"),
    id: z.number().int().nonnegative(),
    /** Absolute path of a folder main has checked against the granted roots. */
    root: z.string().min(1),
  }),
  /** Read-only lines of a file inside the open project, for the Details panel. */
  z.object({
    type: z.literal("preview"),
    id: z.number().int().nonnegative(),
    root: z.string().min(1),
    file: RepoRelativePath,
    startLine: z.number().int().positive(),
    endLine: z.number().int().positive(),
  }),
  /** What summarizing a subject would send, and whether it is already stored. Sends nothing. */
  z.object({
    type: z.literal("summary-plan"),
    id: z.number().int().nonnegative(),
    root: z.string().min(1),
    subject: SummarySubject,
    model: SummaryModelMessage,
    withPrompt: z.boolean(),
  }),
  /** A model's answer to a plan the host made, to sanitize and store. */
  z.object({
    type: z.literal("summary-store"),
    id: z.number().int().nonnegative(),
    root: z.string().min(1),
    key: z.string().regex(/^[0-9a-f]{64}$/),
    answer: z.strictObject({
      text: z.string().max(MAX_ANSWER_CHARS),
      inputTokens: z.number().int().nonnegative(),
      outputTokens: z.number().int().nonnegative(),
      costUsd: z.number().nonnegative(),
    }),
  }),
  /** The subjects of a folder summary job, bottom-up (core folderJob). */
  z.object({
    type: z.literal("summary-job"),
    id: z.number().int().nonnegative(),
    root: z.string().min(1),
    dir: z.union([z.literal(""), RepoRelativePath]),
    model: SummaryModelMessage,
  }),
]);
export type HostRequest = z.infer<typeof HostRequest>;

export const HostEvent = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("progress"),
    id: z.number().int().nonnegative(),
    progress: ProgressMessage,
  }),
  z.object({
    type: z.literal("result"),
    id: z.number().int().nonnegative(),
    graph: z.unknown(),
    info: AnalysisInfoMessage,
  }),
  z.object({
    type: z.literal("error"),
    id: z.number().int().nonnegative(),
    message: z.string(),
  }),
  z.object({
    type: z.literal("preview"),
    id: z.number().int().nonnegative(),
    preview: CodePreviewMessage,
  }),
  /** The watcher re-analyzed the open project and the graph changed. */
  z.object({
    type: z.literal("delta"),
    delta: z.unknown(),
    info: AnalysisInfoMessage,
  }),
  z.object({
    type: z.literal("watch-status"),
    status: WatchStatusMessage,
  }),
  z.object({
    type: z.literal("summary-plan"),
    id: z.number().int().nonnegative(),
    plan: SummaryPlanMessage,
  }),
  z.object({
    type: z.literal("summary-stored"),
    id: z.number().int().nonnegative(),
    /** Undefined when nothing was left of the answer after sanitizing. */
    summary: StoredSummary.optional(),
  }),
  z.object({
    type: z.literal("summary-job"),
    id: z.number().int().nonnegative(),
    items: z.array(SummaryJobItem).max(100_000),
  }),
  /** The host's tripwire refused a network attempt (it must never use the network). */
  z.object({
    type: z.literal("network-attempt"),
    name: z.string().max(200),
  }),
]);
export type HostEvent = z.infer<typeof HostEvent>;
