import { createHash } from "node:crypto";
import {
  MAX_SUMMARY_CHARS,
  SUMMARY_NAMESPACES,
  SUMMARY_PROMPT_VERSION,
  StoredSummary,
  canonicalJson,
  compareCodeUnits,
  nodeFolder,
  sourceLines,
  summaryDependencies,
  summaryKeyText,
  summaryStatus,
  type DerivedStore,
  type Graph,
  type SummaryKeyInputs,
  type SummaryRef,
  type SummaryStatus,
} from "@epoch-dev/core";
import {
  MAX_DEP_SUMMARIES,
  filePrompt,
  folderPrompt,
  isSecretPath,
  looksLikeSecretContent,
  sanitizeSummary,
  type SummaryPrompt,
} from "@epoch-dev/scorers/summary";

/*
 * Summaries over the local cache (M7; CLAUDE.md "Local cache": lazy,
 * hierarchical, cached; no source stored). Planning reads the files and
 * builds the prompt; it never calls a model. In the app the analysis host
 * plans and stores, and main, which alone may use the network, sends.
 *
 * A summary is stored under a key made from what was sent (core
 * summaryKeyText), so an unchanged file finds it again. A pointer per
 * project and subject keeps the latest one, shown while it is stale.
 */

const sha256 = (text: string): string =>
  createHash("sha256").update(text).digest("hex");

export interface SummaryModelId {
  readonly provider: "anthropic" | "local";
  readonly model: string;
}

const Pointer = StoredSummary.pick({ provider: true }).extend({
  key: StoredSummary.shape.contentHash,
});

/** Summaries in a cache's derived store, for one project. */
export class SummaryStore {
  private readonly cache: DerivedStore;
  private readonly root: string;

  constructor(cache: DerivedStore, root: string) {
    this.cache = cache;
    this.root = root;
  }

  key(inputs: SummaryKeyInputs): string {
    return sha256(summaryKeyText(inputs));
  }

  get(
    provider: SummaryModelId["provider"],
    key: string,
  ): StoredSummary | undefined {
    const row = this.cache.getDerived(SUMMARY_NAMESPACES[provider], key);
    const parsed = StoredSummary.safeParse(row?.value);
    return parsed.success ? parsed.data : undefined;
  }

  private pointerKey(subject: string): string {
    return sha256(`${this.root}\u0000${subject}`);
  }

  /** The subject's most recent summary in this project, under any key. */
  latest(subject: string): StoredSummary | undefined {
    const row = this.cache.getDerived(
      SUMMARY_NAMESPACES.latest,
      this.pointerKey(subject),
    );
    const pointer = Pointer.safeParse(row?.value);
    return pointer.success
      ? this.get(pointer.data.provider, pointer.data.key)
      : undefined;
  }

  /** The latest summary as an input to another prompt: its subject and text hash. */
  ref(subject: string): SummaryRef | undefined {
    const s = this.latest(subject);
    return s ? { subject, hash: sha256(s.text) } : undefined;
  }

  put(key: string, summary: StoredSummary): void {
    this.cache.putDerived(
      SUMMARY_NAMESPACES[summary.provider],
      key,
      key,
      summary,
    );
    this.cache.putDerived(
      SUMMARY_NAMESPACES.latest,
      this.pointerKey(summary.subject),
      key,
      { provider: summary.provider, key },
    );
  }
}

/** What summaries read: the analyzed project. */
export interface SummarySource {
  readonly root: string;
  readonly graph: Graph;
  /** Package node id -> member files (AnalyzeResult.packages). */
  readonly packages: ReadonlyMap<string, readonly string[]>;
  /** A repo-relative file's text, read inside the project root. */
  readonly readText: (rel: string) => string | undefined;
}

export type SummaryUnavailable =
  /** No such node or folder in the graph. */
  | "not-in-graph"
  /** Its name or content looks like a secret: never sent. */
  | "secret"
  | "unreadable"
  | "empty"
  /** A folder: some children have no summary yet (`missing`). */
  | "children-missing";

export type SummaryPlan =
  | {
      readonly ok: true;
      readonly subject: string;
      readonly kind: "file" | "package" | "dir";
      readonly key: string;
      readonly contentHash: string;
      /** Summaries in the prompt. */
      readonly used: readonly SummaryRef[];
      readonly prompt: SummaryPrompt;
      readonly status: SummaryStatus;
      /** Source lines a stored answer must not repeat. Stays in the host. */
      readonly forbidden: ReadonlySet<string>;
      readonly truncated: boolean;
      /** Files left out because they look like secrets. */
      readonly excluded: readonly string[];
    }
  | {
      readonly ok: false;
      readonly subject: string;
      readonly reason: SummaryUnavailable;
      readonly missing?: readonly string[];
      /** A folder waiting for children: how many it has (for a worst-case estimate). */
      readonly children?: number;
    };

const DIR = "dir:";
const parentOf = (folder: string) =>
  folder.includes("/") ? folder.slice(0, folder.lastIndexOf("/")) : "";

/** A file's text, unless it is a secret by name or content. */
function readSendable(
  src: SummarySource,
  rel: string,
): { text: string } | { reason: "secret" | "unreadable" } {
  if (isSecretPath(rel)) return { reason: "secret" };
  const text = src.readText(rel);
  if (text === undefined) return { reason: "unreadable" };
  if (looksLikeSecretContent(text)) return { reason: "secret" };
  return { text };
}

/**
 * What summarizing `subject` would send, and whether a summary of exactly
 * that is already stored. Never sends anything.
 */
export function planSummary(
  src: SummarySource,
  store: SummaryStore,
  subject: string,
  model: SummaryModelId,
): SummaryPlan {
  const unavailable = (
    reason: SummaryUnavailable,
    missing?: readonly string[],
    children?: number,
  ): SummaryPlan => ({
    ok: false,
    subject,
    reason,
    ...(missing ? { missing } : {}),
    ...(children === undefined ? {} : { children }),
  });
  const finish = (
    kind: "file" | "package" | "dir",
    prompt: SummaryPrompt,
    content: string,
    used: readonly SummaryRef[],
    extra: {
      forbidden: ReadonlySet<string>;
      truncated: boolean;
      excluded: readonly string[];
    },
  ): SummaryPlan => {
    const contentHash = sha256(content);
    const key = store.key({
      promptVersion: SUMMARY_PROMPT_VERSION,
      provider: model.provider,
      model: model.model,
      subject,
      contentHash,
    });
    return {
      ok: true,
      subject,
      kind,
      key,
      contentHash,
      used,
      prompt,
      status: summaryStatus({
        hit: store.get(model.provider, key),
        latest: store.latest(subject),
        currentDeps: used,
      }),
      ...extra,
    };
  };

  if (subject.startsWith(DIR)) {
    const dir = subject.slice(DIR.length);
    const files: string[] = [];
    const subdirs = new Set<string>();
    let any = false;
    for (const n of src.graph.nodes) {
      const folder = nodeFolder(n.id, src.graph);
      if (folder === dir) files.push(n.id);
      else if (dir === "" || folder.startsWith(`${dir}/`)) {
        let child = folder;
        while (parentOf(child) !== dir) child = parentOf(child);
        subdirs.add(child);
      } else continue;
      any = true;
    }
    if (!any) return unavailable("not-in-graph");
    const excluded: string[] = [];
    const children: { subject: string; kind: "file" | "folder" }[] = [];
    for (const id of files.sort(compareCodeUnits)) {
      const kind = src.graph.nodes.find((n) => n.id === id)?.kind;
      if (kind === "file") {
        // A secret is left out and listed; a file with nothing to send
        // (empty, like many __init__.py, or unreadable) never gets a summary
        // to wait for.
        const read = readSendable(src, id);
        if ("reason" in read) {
          if (read.reason === "secret") excluded.push(id);
          continue;
        }
        if (read.text.trim() === "") continue;
      }
      children.push({ subject: id, kind: "file" });
    }
    for (const d of [...subdirs].sort(compareCodeUnits))
      children.push({ subject: `${DIR}${d}`, kind: "folder" });
    const refs = children.map((c) => ({ c, ref: store.ref(c.subject) }));
    const missing = refs.filter((r) => !r.ref).map((r) => r.c.subject);
    if (missing.length > 0)
      return unavailable("children-missing", missing, children.length);
    const used = refs.flatMap((r) => (r.ref ? [r.ref] : []));
    const prompt = folderPrompt({
      path: dir,
      children: children.map((c) => ({
        subject: c.kind === "folder" ? c.subject.slice(DIR.length) : c.subject,
        kind: c.kind,
        text: store.latest(c.subject)?.text ?? "",
      })),
    });
    return finish("dir", prompt, canonicalJson(used), used, {
      forbidden: new Set(),
      truncated: false,
      excluded,
    });
  }

  const node = src.graph.nodes.find((n) => n.id === subject);
  if (!node) return unavailable("not-in-graph");
  let source: string;
  const excluded: string[] = [];
  if (node.kind === "package") {
    const parts: string[] = [];
    for (const member of src.packages.get(subject) ?? []) {
      const read = readSendable(src, member);
      if ("reason" in read) {
        if (read.reason === "secret") excluded.push(member);
        continue;
      }
      parts.push(`=== ${member} ===\n${read.text}`);
    }
    if (parts.length === 0)
      return unavailable(excluded.length > 0 ? "secret" : "unreadable");
    source = parts.join("\n");
  } else {
    const read = readSendable(src, subject);
    if ("reason" in read) return unavailable(read.reason);
    source = read.text;
  }
  if (source.trim() === "") return unavailable("empty");
  const used = summaryDependencies(src.graph, subject)
    .flatMap((d) => {
      const ref = store.ref(d);
      return ref ? [ref] : [];
    })
    .slice(0, MAX_DEP_SUMMARIES);
  const p = filePrompt({
    path: subject,
    language: node.language,
    loc: node.loc,
    source,
    deps: used.map((r) => ({
      subject: r.subject,
      text: store.latest(r.subject)?.text ?? "",
    })),
  });
  return finish(
    node.kind === "package" ? "package" : "file",
    { system: p.system, user: p.user },
    p.sent,
    used,
    { forbidden: sourceLines(p.sent), truncated: p.truncated, excluded },
  );
}

/**
 * Stores a model's answer to a plan, sanitized (no code blocks, no
 * sentence repeating a source line, capped). Undefined, and nothing
 * stored, when nothing is left.
 */
export function storeSummary(
  store: SummaryStore,
  plan: SummaryPlan & { ok: true },
  model: SummaryModelId,
  answer: {
    readonly text: string;
    readonly usage: {
      readonly inputTokens: number;
      readonly outputTokens: number;
    };
    readonly costUsd: number;
  },
  now: Date,
): StoredSummary | undefined {
  const text = sanitizeSummary(answer.text, {
    forbidden: plan.forbidden,
    maxChars: MAX_SUMMARY_CHARS,
  });
  if (text === "") return undefined;
  const summary = StoredSummary.parse({
    subject: plan.subject,
    provider: model.provider,
    model: model.model,
    promptVersion: SUMMARY_PROMPT_VERSION,
    contentHash: plan.contentHash,
    text,
    used: plan.used,
    createdAt: now.toISOString(),
    usage: { ...answer.usage, costUsd: answer.costUsd },
  });
  store.put(plan.key, summary);
  return summary;
}
