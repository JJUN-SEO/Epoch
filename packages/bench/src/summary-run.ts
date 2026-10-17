import { createHash } from "node:crypto";
import { MAX_SUMMARY_CHARS, canonicalJson, folderJob } from "@epoch-dev/core";
import {
  planSummary,
  storeSummary,
  type SummaryModelId,
  type SummaryPlan,
  type SummarySource,
  type SummaryStore,
} from "@epoch-dev/engine";
import { estimateTokens } from "@epoch-dev/scorers/cost";
import { SUMMARY_MAX_OUTPUT_TOKENS } from "@epoch-dev/scorers/summary";

/*
 * The measured half of bench:summaries (M7): summarize a whole project the
 * way the app's root folder job does (every file and package bottom-up,
 * then each folder from the deepest up), against a summary cache, and
 * record what each request cost. Run once on an empty cache for the full
 * cost, then again after a change for the incremental cost: plans whose
 * summary is fresh send nothing.
 */

export interface Answer {
  readonly text: string;
  readonly stop: "end" | "max-tokens" | "refusal" | "other";
  readonly usage: {
    readonly inputTokens: number;
    readonly outputTokens: number;
  };
  readonly costUsd: number;
}

type ReadyPlan = SummaryPlan & { ok: true };

/** Answers one plan. Throwing stops the run (a refused key, the spend cap). */
export type Generate = (plan: ReadyPlan) => Promise<Answer>;

/** Why a subject was sent: new, its content changed, or only summaries it uses did. */
export type SentStatus = "missing" | "stale-file" | "stale-dependencies";

export interface SentRow {
  readonly subject: string;
  readonly kind: "file" | "package" | "dir";
  readonly status: SentStatus;
  /** False for a refusal, a cut-off answer, or one the sanitizer emptied. */
  readonly stored: boolean;
  readonly stop: Answer["stop"];
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly costUsd: number;
  readonly ms: number;
}

export interface JobReport {
  /** Subjects in the job. */
  readonly subjects: number;
  /** Plans whose summary was already fresh: nothing sent. */
  readonly fresh: number;
  /** Plans that could not be made (a secret, a folder waiting for children). */
  readonly skipped: readonly {
    readonly subject: string;
    readonly reason: string;
  }[];
  readonly sent: readonly SentRow[];
  /** The message of the error that stopped the run early. */
  readonly stoppedBy?: string;
}

export async function runSummaryJob(
  src: SummarySource,
  store: SummaryStore,
  model: SummaryModelId,
  generate: Generate,
  now: () => Date = () => new Date(),
): Promise<JobReport> {
  const subjects = folderJob(src.graph, "");
  let fresh = 0;
  const skipped: { subject: string; reason: string }[] = [];
  const sent: SentRow[] = [];
  for (const subject of subjects) {
    const plan = planSummary(src, store, subject, model);
    if (!plan.ok) {
      skipped.push({ subject, reason: plan.reason });
      continue;
    }
    if (plan.status.state === "fresh") {
      fresh++;
      continue;
    }
    const status: SentStatus =
      plan.status.state === "missing" ? "missing" : `stale-${plan.status.why}`;
    const t = performance.now();
    let answer: Answer;
    try {
      answer = await generate(plan);
    } catch (err) {
      return {
        subjects: subjects.length,
        fresh,
        skipped,
        sent,
        stoppedBy: err instanceof Error ? err.message : String(err),
      };
    }
    const stored =
      answer.stop === "end" &&
      storeSummary(
        store,
        plan,
        model,
        { text: answer.text, usage: answer.usage, costUsd: answer.costUsd },
        now(),
      ) !== undefined;
    sent.push({
      subject,
      kind: plan.kind,
      status,
      stored,
      stop: answer.stop,
      inputTokens: answer.usage.inputTokens,
      outputTokens: answer.usage.outputTokens,
      costUsd: answer.costUsd,
      ms: performance.now() - t,
    });
  }
  return { subjects: subjects.length, fresh, skipped, sent };
}

/**
 * No model: Epoch's own upper estimate of each request. Input is the byte
 * estimate of the prompt, output the cap, and the stored stand-in text is
 * full length (so prompts that carry it are as large as they can be) and
 * changes whenever the plan's input does (so, unlike a model that happened
 * to repeat itself, every change reaches what depends on it).
 */
export function estimateOnly(): Generate {
  return (plan) => {
    const seed = createHash("sha256")
      .update(`${plan.contentHash}\u0000${canonicalJson(plan.used)}`)
      .digest("hex")
      .slice(0, 16);
    const sentence = `Stand-in ${seed}.`;
    const text = Array.from(
      { length: Math.ceil(MAX_SUMMARY_CHARS / (sentence.length + 1)) },
      () => sentence,
    )
      .join(" ")
      .slice(0, MAX_SUMMARY_CHARS);
    return Promise.resolve({
      text,
      stop: "end",
      usage: {
        inputTokens: estimateTokens(plan.prompt.system + plan.prompt.user),
        outputTokens: SUMMARY_MAX_OUTPUT_TOKENS,
      },
      costUsd: 0,
    });
  };
}
