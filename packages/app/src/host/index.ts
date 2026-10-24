import path from "node:path";
import { performance } from "node:perf_hooks";
import {
  MAX_SUMMARY_CHARS,
  diffGraphs,
  folderJob,
  isEmptyDelta,
  type AnalysisInfo,
  type Graph,
  type Progress,
} from "@epoch-dev/core";
import {
  ChurnMemo,
  FsReader,
  ParsePool,
  SummaryStore,
  analyze,
  localEmbedder,
  openCache,
  planSummary,
  storeSummary,
  toPosix,
  watchProject,
  type AnalyzeOptions,
  type AnalyzeResult,
  type ProjectWatcher,
  type SummaryModelId,
  type SummaryPlan,
} from "@epoch-dev/engine";
import type { Embedder } from "@epoch-dev/core";
import { estimateTokens } from "@epoch-dev/scorers/cost";
import { folderPrompt } from "@epoch-dev/scorers/summary";
import { installTripwire } from "@epoch-dev/scorers/tripwire";
import {
  HostRequest,
  MAX_PREVIEW_LINES,
  MAX_PREVIEW_LINE_CHARS,
  type HostEvent,
  type SummaryJobItem,
  type SummaryPlanMessage,
} from "../shared/host-protocol";

/*
 * The analysis host (an Electron utilityProcess). It runs the same engine as
 * the CLI, against the shared per-user cache, on folders main has checked
 * against the user's granted roots. It reads only inside the given folder
 * (the engine's FsReader) and never executes project code. After an analysis
 * it watches the folder and sends main the difference each time the graph
 * changes.
 *
 * The host never uses the network: main alone sends anything, through its
 * one egress (ADR-016). A tripwire refuses every socket, DNS lookup and
 * fetch here, and reports each attempt to main. For summaries the host
 * reads the files and builds the prompt; main sends it and hands the answer
 * back, which the host sanitizes and stores.
 *
 * With the bundled embedding model (main passes its folder), the first graph
 * is sent without similarity hints, marked pending; the watcher then
 * re-analyzes with the model and sends the difference, and keeps the model
 * for later changes. Vectors are cached, so a project opened again embeds
 * only its changed files.
 */

const port = process.parentPort;
installTripwire({
  onAttempt: (name) => {
    send({ type: "network-attempt", name });
  },
});
const cache = openCache();
// The bundled worker sits next to this file (electron.vite.config.ts).
const pool = new ParsePool({
  workerFile: path.join(import.meta.dirname, "parse-worker.js"),
});
const churnMemo = new ChurnMemo();
const embedder = embedderFrom(process.argv);
let queue = Promise.resolve();
let watcher: ProjectWatcher | undefined;
/** The open project's latest analysis, which summaries read. */
let current: AnalyzeResult | undefined;
/** The open project's analysis options, which the watcher's re-analyses use. */
let options: AnalyzeOptions | undefined;
/**
 * Plans whose answers may come back, by key: the source lines a stored
 * answer must not repeat stay here, never in main.
 */
const plans = new Map<
  string,
  { readonly plan: SummaryPlan & { ok: true }; readonly model: SummaryModelId }
>();
const MAX_PLANS = 64;

/** Larger files are not previewed: reading them would only stall the host. */
const MAX_PREVIEW_FILE_BYTES = 8 * 1024 * 1024;

/**
 * The local model in the folder after --embedding-model, started only when a
 * file needs a vector. A folder that cannot be read still gives an embedder,
 * one that fails, so the model is reported unavailable rather than off.
 */
function embedderFrom(argv: readonly string[]): Embedder | undefined {
  const at = argv.indexOf("--embedding-model");
  const dir = at < 0 ? undefined : argv[at + 1];
  if (dir === undefined) return undefined;
  try {
    return localEmbedder(dir);
  } catch (error) {
    return {
      modelId: "bundled model",
      embed: () =>
        Promise.reject(
          error instanceof Error ? error : new Error(String(error)),
        ),
    };
  }
}

/** At most one progress message per interval, plus every stage change and stage end. */
const PROGRESS_INTERVAL_MS = 50;

function send(event: HostEvent): void {
  port.postMessage(event);
}

const infoOf = (r: AnalyzeResult): AnalysisInfo => ({
  git: r.meta.git,
  coverage: r.meta.coverage,
  config: r.meta.config,
  findings: r.meta.findings,
  hints: r.meta.hints,
});

/**
 * Lines of a file in the project, for the read-only code preview. The path
 * is repo-relative (checked by the schema) and read through the engine's
 * FsReader, which stays inside the root and refuses symlinks out of it.
 */
function preview(request: Extract<HostRequest, { type: "preview" }>): void {
  const reader = new FsReader(request.root);
  const file = path.resolve(request.root, request.file);
  const size = reader.statFile(file)?.size;
  const text =
    size !== undefined && size <= MAX_PREVIEW_FILE_BYTES
      ? reader.readFile(file)
      : undefined;
  if (text === undefined) {
    send({
      type: "error",
      id: request.id,
      message: "That file cannot be read.",
    });
    return;
  }
  const all = text.split(/\r\n|\r|\n/);
  const start = Math.min(request.startLine, Math.max(all.length, 1));
  const end = Math.min(
    Math.max(request.endLine, start),
    start + MAX_PREVIEW_LINES - 1,
    all.length,
  );
  send({
    type: "preview",
    id: request.id,
    preview: {
      file: request.file,
      startLine: start,
      lines: all
        .slice(start - 1, end)
        .map((l) =>
          l.length > MAX_PREVIEW_LINE_CHARS
            ? `${l.slice(0, MAX_PREVIEW_LINE_CHARS)}…`
            : l,
        ),
    },
  });
}

/** The open project, if `root` (from main) names it. */
function project(root: string): AnalyzeResult | undefined {
  return current?.root === toPosix(path.resolve(root)) ? current : undefined;
}

/** Plans a summary of the open project (engine planSummary); sends nothing. */
function plan(
  open: AnalyzeResult,
  subject: string,
  model: SummaryModelId,
): SummaryPlan {
  const reader = new FsReader(open.root);
  return planSummary(
    {
      root: open.root,
      graph: open.graph,
      packages: open.packages,
      readText: (rel) => reader.readFile(`${open.root}/${rel}`),
    },
    new SummaryStore(cache, open.root),
    subject,
    model,
  );
}

/** Files whose content a plan's prompt holds: the file, a package's members, none for a folder. */
function sendsOf(open: AnalyzeResult, p: SummaryPlan & { ok: true }): string[] {
  if (p.kind === "file") return [p.subject];
  if (p.kind === "package")
    return (open.packages.get(p.subject) ?? []).filter(
      (m) => !p.excluded.includes(m),
    );
  return [];
}

/** A folder's prompt at its largest: every child summary at the length cap. */
function folderWorstCase(dir: string, children: number): number {
  const base = folderPrompt({ path: dir, children: [] });
  return (
    estimateTokens(base.system + base.user) +
    children * estimateTokens("x".repeat(MAX_SUMMARY_CHARS + 200))
  );
}

function summaryPlan(
  request: Extract<HostRequest, { type: "summary-plan" }>,
): void {
  const open = project(request.root);
  if (!open) {
    send({
      type: "summary-plan",
      id: request.id,
      plan: { ok: false, subject: request.subject, reason: "no-project" },
    });
    return;
  }
  const p = plan(open, request.subject, request.model);
  let message: SummaryPlanMessage;
  if (p.ok) {
    plans.delete(p.key);
    plans.set(p.key, { plan: p, model: request.model });
    for (const key of plans.keys()) {
      if (plans.size <= MAX_PLANS) break;
      plans.delete(key);
    }
    message = {
      ok: true,
      subject: p.subject,
      kind: p.kind,
      key: p.key,
      status: p.status,
      used: p.used.length,
      truncated: p.truncated,
      excluded: [...p.excluded],
      sends: sendsOf(open, p),
      inputTokens: estimateTokens(p.prompt.system + p.prompt.user),
      ...(request.withPrompt ? { prompt: p.prompt } : {}),
    };
  } else {
    message = {
      ok: false,
      subject: p.subject,
      reason: p.reason,
      ...(p.missing ? { missing: [...p.missing] } : {}),
    };
  }
  send({ type: "summary-plan", id: request.id, plan: message });
}

function summaryStore(
  request: Extract<HostRequest, { type: "summary-store" }>,
): void {
  const open = project(request.root);
  const pending = plans.get(request.key);
  if (!open || !pending) {
    send({
      type: "error",
      id: request.id,
      message: "That summary request is no longer current.",
    });
    return;
  }
  plans.delete(request.key);
  const { text, inputTokens, outputTokens, costUsd } = request.answer;
  const summary = storeSummary(
    new SummaryStore(cache, open.root),
    pending.plan,
    pending.model,
    { text, usage: { inputTokens, outputTokens }, costUsd },
    new Date(),
  );
  send({
    type: "summary-stored",
    id: request.id,
    ...(summary ? { summary } : {}),
  });
}

function summaryJob(
  request: Extract<HostRequest, { type: "summary-job" }>,
): void {
  const open = project(request.root);
  const items: SummaryJobItem[] = [];
  for (const subject of open ? folderJob(open.graph, request.dir) : []) {
    if (!open) break;
    const p = plan(open, subject, request.model);
    if (p.ok) {
      const fresh = p.status.state === "fresh";
      items.push({
        subject,
        state: fresh ? "fresh" : "todo",
        inputTokens: fresh
          ? 0
          : estimateTokens(p.prompt.system + p.prompt.user),
        sends: fresh ? [] : sendsOf(open, p),
        excluded: [...p.excluded],
      });
    } else if (p.reason === "children-missing") {
      items.push({
        subject,
        state: "todo",
        inputTokens: folderWorstCase(subject.slice(4), p.children ?? 0),
        sends: [],
        excluded: [],
      });
    } else {
      items.push({
        subject,
        state: "skip",
        inputTokens: 0,
        sends: [],
        excluded: [],
      });
    }
  }
  send({ type: "summary-job", id: request.id, items });
}

async function run(
  request: Extract<HostRequest, { type: "analyze" }>,
): Promise<void> {
  await watcher?.close();
  watcher = undefined;
  current = undefined;
  options = undefined;
  plans.clear();
  let lastStage: Progress["stage"] | undefined;
  let lastSent = 0;
  const onProgress = (progress: Progress) => {
    const now = performance.now();
    if (
      progress.stage !== lastStage ||
      progress.done === progress.total ||
      now - lastSent >= PROGRESS_INTERVAL_MS
    ) {
      lastStage = progress.stage;
      lastSent = now;
      send({ type: "progress", id: request.id, progress });
    }
  };
  const first: AnalyzeOptions = {
    cache,
    pool,
    churnMemo,
    ...(request.coverageReport !== undefined
      ? { coverageReport: request.coverageReport }
      : {}),
  };
  options = first;
  let result: AnalyzeResult;
  try {
    result = await analyze(request.root, { ...first, onProgress });
  } catch (error) {
    send({
      type: "error",
      id: request.id,
      message: error instanceof Error ? error.message : String(error),
    });
    return;
  }
  current = result;
  const used = infoOf(result);
  const firstInfo: AnalysisInfo = embedder
    ? {
        ...used,
        hints: {
          ...used.hints,
          embeddings: { status: "pending", model: embedder.modelId, pairs: 0 },
        },
      }
    : used;
  send({
    type: "result",
    id: request.id,
    graph: result.graph,
    info: firstInfo,
  });
  let graph: Graph = result.graph;
  let info = JSON.stringify(firstInfo);
  watcher = await watchProject(result, {
    analyze: first,
    onUpdate: (next) => {
      current = next;
      const delta = diffGraphs(graph, next.graph);
      const nextInfo = infoOf(next);
      if (isEmptyDelta(delta) && JSON.stringify(nextInfo) === info) return;
      graph = next.graph;
      info = JSON.stringify(nextInfo);
      send({ type: "delta", delta, info: nextInfo });
    },
    onStatus: (status) => {
      send({ type: "watch-status", status });
    },
  });
  if (embedder) {
    options = { ...first, hints: { embeddings: { embedder } } };
    await watcher.reconfigure(options);
  }
}

/** Re-analyzes the open project with another coverage report; the watcher sends the change. */
async function setCoverageReport(
  request: Extract<HostRequest, { type: "coverage-report" }>,
): Promise<void> {
  if (!watcher || !options || !project(request.root)) {
    send({ type: "error", id: request.id, message: "No project is open." });
    return;
  }
  const { coverageReport: _previous, ...rest } = options;
  options =
    request.report === null
      ? rest
      : { ...rest, coverageReport: request.report };
  await watcher.reconfigure(options);
  send({ type: "coverage-report-set", id: request.id });
}

port.on("message", ({ data }) => {
  const parsed = HostRequest.safeParse(data);
  if (!parsed.success) return;
  const request = parsed.data;
  // Previews and summaries are small reads: they never wait behind an analysis.
  if (request.type === "preview") preview(request);
  else if (request.type === "summary-plan") summaryPlan(request);
  else if (request.type === "summary-store") summaryStore(request);
  else if (request.type === "summary-job") summaryJob(request);
  else if (request.type === "coverage-report")
    queue = queue.then(() => setCoverageReport(request));
  else queue = queue.then(() => run(request));
});

process.on("exit", () => {
  cache.close();
});
