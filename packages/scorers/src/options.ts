import {
  ANTHROPIC_ORIGIN,
  DEFAULT_LLM_MODEL,
  anthropicBackend,
} from "./anthropic.js";
import { SpendCap } from "./cost.js";
import { jevUnavailable } from "./jev.js";
import type { ModelBackend, ModelRunReport } from "./model.js";
import { createNet } from "./net.js";
import { OLLAMA_ORIGIN, ollamaBackend } from "./ollama.js";

/*
 * The --scorer options shared by `epoch` and `pnpm bench:scorers`. The
 * heuristic (the default) runs on this machine with no model. The others
 * are opt-in (CLAUDE.md "Privacy and data flow"): `local` asks an Ollama
 * server on this machine; `llm` sends file excerpts to Anthropic with the
 * user's own key (ANTHROPIC_API_KEY), only after --consent-send, within
 * --max-spend at the user's own --price-in and --price-out; `jev` is not
 * built (its docs could not be read).
 */

export class ScorerUsageError extends Error {}

export const SCORER_ARGS = {
  scorer: { type: "string", default: "heuristic" },
  model: { type: "string" },
  "max-pairs": { type: "string" },
  "max-spend": { type: "string" },
  "price-in": { type: "string" },
  "price-out": { type: "string" },
  "consent-send": { type: "boolean", default: false },
} as const;

export interface ScorerValues {
  readonly scorer: string;
  readonly model?: string | undefined;
  readonly "max-pairs"?: string | undefined;
  readonly "max-spend"?: string | undefined;
  readonly "price-in"?: string | undefined;
  readonly "price-out"?: string | undefined;
  readonly "consent-send": boolean;
}

export const DEFAULT_MAX_PAIRS = 200;

function amount(option: string, raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) {
    throw new ScorerUsageError(`${option} must be a number of USD, got ${raw}`);
  }
  return n;
}

export interface ResolvedModel {
  readonly backend: ModelBackend;
  /** Present for paid backends: the cap at the user's prices. */
  readonly spend?: SpendCap;
  readonly maxPairs: number;
  readonly consent: boolean;
}

/** The model backend the options ask for, or undefined for the heuristic. Throws ScorerUsageError on bad options. */
export function resolveModel(
  values: ScorerValues,
  env: NodeJS.ProcessEnv = process.env,
): ResolvedModel | undefined {
  const kind = values.scorer;
  if (kind === "heuristic") {
    if (
      values.model !== undefined ||
      values["max-pairs"] !== undefined ||
      values["max-spend"] !== undefined ||
      values["price-in"] !== undefined ||
      values["price-out"] !== undefined ||
      values["consent-send"]
    ) {
      throw new ScorerUsageError(
        "--model, --max-pairs, --max-spend, --price-in, --price-out and --consent-send apply to --scorer local or llm",
      );
    }
    return undefined;
  }
  if (kind === "jev") jevUnavailable();
  if (kind !== "local" && kind !== "llm") {
    throw new ScorerUsageError(
      `--scorer must be heuristic, local, llm or jev, got ${kind}`,
    );
  }
  const maxPairsRaw = values["max-pairs"];
  const maxPairs =
    maxPairsRaw === undefined ? DEFAULT_MAX_PAIRS : Number(maxPairsRaw);
  if (!Number.isInteger(maxPairs) || maxPairs < 1) {
    throw new ScorerUsageError(
      `--max-pairs must be a positive whole number, got ${String(maxPairsRaw)}`,
    );
  }
  if (kind === "local") {
    if (values.model === undefined) {
      throw new ScorerUsageError(
        "--scorer local needs --model, the name of a model your Ollama server has",
      );
    }
    return {
      backend: ollamaBackend({
        model: values.model,
        net: createNet({ offline: false, allow: [OLLAMA_ORIGIN] }),
      }),
      maxPairs,
      consent: values["consent-send"],
    };
  }
  const apiKey = env.ANTHROPIC_API_KEY;
  if (apiKey === undefined || apiKey === "") {
    throw new ScorerUsageError(
      "--scorer llm needs your own Anthropic key in the ANTHROPIC_API_KEY environment variable",
    );
  }
  const maxSpend = amount("--max-spend", values["max-spend"]);
  const priceIn = amount("--price-in", values["price-in"]);
  const priceOut = amount("--price-out", values["price-out"]);
  if (
    maxSpend === undefined ||
    priceIn === undefined ||
    priceOut === undefined
  ) {
    throw new ScorerUsageError(
      "--scorer llm spends your money: give --max-spend <USD> and your model's prices, --price-in and --price-out (USD per million tokens, from Anthropic's price list)",
    );
  }
  return {
    backend: anthropicBackend({
      apiKey,
      model: values.model ?? DEFAULT_LLM_MODEL,
      net: createNet({ offline: false, allow: [ANTHROPIC_ORIGIN] }),
    }),
    spend: new SpendCap(maxSpend, {
      inputPerMTok: priceIn,
      outputPerMTok: priceOut,
    }),
    maxPairs,
    consent: values["consent-send"],
  };
}

/** One line on what a model scorer did. */
export function runSummary(
  backend: ModelBackend,
  r: ModelRunReport,
  spend?: SpendCap,
): string {
  const parts = [
    `${backend.id} scorer: ${String(r.scored)} pairs scored of ${String(r.sent)} sent`,
    r.failed > 0 ? `${String(r.failed)} without a usable answer` : "",
    r.skippedSecret > 0
      ? `${String(r.skippedSecret)} skipped (files that look like secrets)`
      : "",
    r.overLimit > 0 ? `${String(r.overLimit)} over --max-pairs` : "",
    r.stoppedAtCap
      ? `stopped at the spend cap, ${String(r.unsentAtCap)} not sent`
      : "",
    r.unverifiedSymbols > 0
      ? `${String(r.unverifiedSymbols)} cited names not found in the files (dropped)`
      : "",
    `${String(r.usage.inputTokens)} input and ${String(r.usage.outputTokens)} output tokens`,
    spend
      ? `$${spend.spentUsd.toFixed(4)} of your $${spend.capUsd.toFixed(2)} cap at your prices`
      : "",
  ];
  return parts.filter((p) => p !== "").join("; ");
}
