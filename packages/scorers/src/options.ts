import {
  ANTHROPIC_ORIGIN,
  DEFAULT_LLM_MODEL,
  anthropicBackend,
} from "./anthropic.js";
import { SpendCap } from "./cost.js";
import { DEFAULT_JEV_MODEL, JEV_ORIGIN, jevBackend } from "./jev.js";
import type { ModelBackend, ModelRunReport } from "./model.js";
import { createNet } from "./net.js";
import { OLLAMA_ORIGIN, ollamaBackend } from "./ollama.js";

/*
 * The --scorer options shared by `epoch` and `pnpm bench:scorers`. The
 * heuristic (the default) runs on this machine with no model. The others
 * are opt-in (CLAUDE.md "Privacy and data flow"): `local` asks an Ollama
 * server on this machine; `llm` sends file excerpts to Anthropic with the
 * user's own key (ANTHROPIC_API_KEY), only after --consent-send, within
 * --max-spend at the user's own --price-in and --price-out; `jev` sends
 * the same excerpts to TypeSafe AI's Jev API with the user's own key
 * (JEV_API_KEY), under the same rules (ADR-017). A key is only ever read
 * from the environment (--key-env names another variable), never argv.
 */

export class ScorerUsageError extends Error {}

export const SCORER_ARGS = {
  scorer: { type: "string", default: "heuristic" },
  model: { type: "string" },
  "max-pairs": { type: "string" },
  "max-spend": { type: "string" },
  "price-in": { type: "string" },
  "price-out": { type: "string" },
  "key-env": { type: "string" },
  "consent-send": { type: "boolean", default: false },
} as const;

export interface ScorerValues {
  readonly scorer: string;
  readonly model?: string | undefined;
  readonly "max-pairs"?: string | undefined;
  readonly "max-spend"?: string | undefined;
  readonly "price-in"?: string | undefined;
  readonly "price-out"?: string | undefined;
  readonly "key-env"?: string | undefined;
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

/** Where a scorer's requests may go: offline mode, and the fetch underneath (the CLI's, from before its tripwire). */
export interface ScorerNetwork {
  readonly offline?: boolean;
  readonly fetch?: typeof fetch;
}

/** The model backend the options ask for, or undefined for the heuristic. Throws ScorerUsageError on bad options. */
export function resolveModel(
  values: ScorerValues,
  env: NodeJS.ProcessEnv = process.env,
  network: ScorerNetwork = {},
): ResolvedModel | undefined {
  const offline = network.offline === true;
  const fetchOpt = network.fetch ? { fetch: network.fetch } : {};
  const kind = values.scorer;
  if (kind === "heuristic") {
    if (
      values.model !== undefined ||
      values["max-pairs"] !== undefined ||
      values["max-spend"] !== undefined ||
      values["price-in"] !== undefined ||
      values["price-out"] !== undefined ||
      values["key-env"] !== undefined ||
      values["consent-send"]
    ) {
      throw new ScorerUsageError(
        "--model, --max-pairs, --max-spend, --price-in, --price-out, --key-env and --consent-send apply to --scorer local, llm or jev",
      );
    }
    return undefined;
  }
  if (kind !== "local" && kind !== "llm" && kind !== "jev") {
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
    if (values["key-env"] !== undefined) {
      throw new ScorerUsageError(
        "--key-env applies to --scorer llm or jev (an Ollama server needs no key)",
      );
    }
    if (values.model === undefined) {
      throw new ScorerUsageError(
        "--scorer local needs --model, the name of a model your Ollama server has",
      );
    }
    return {
      backend: ollamaBackend({
        model: values.model,
        // A model on this machine keeps working offline: nothing leaves it.
        net: createNet({
          offline,
          allow: [OLLAMA_ORIGIN],
          offlineAllow: [OLLAMA_ORIGIN],
          ...fetchOpt,
        }),
      }),
      maxPairs,
      consent: values["consent-send"],
    };
  }
  const remote = REMOTE[kind];
  if (offline) {
    throw new ScorerUsageError(
      `--offline: --scorer ${kind} would send to ${remote.origin}; drop --offline, or use --scorer local (a model on this machine)`,
    );
  }
  const keyEnv = values["key-env"] ?? remote.keyEnv;
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(keyEnv)) {
    throw new ScorerUsageError(
      "--key-env must be an environment variable name",
    );
  }
  const apiKey = env[keyEnv];
  if (apiKey === undefined || apiKey === "") {
    throw new ScorerUsageError(
      `--scorer ${kind} needs your own ${remote.label} key: set ${keyEnv}, or store it with \`epoch auth set ${remote.auth}\``,
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
      `--scorer ${kind} spends your money: give --max-spend <USD> and your model's prices, --price-in and --price-out (USD per million tokens, from ${remote.prices})`,
    );
  }
  const net = createNet({ offline, allow: [remote.origin], ...fetchOpt });
  return {
    backend:
      kind === "llm"
        ? anthropicBackend({
            apiKey,
            model: values.model ?? DEFAULT_LLM_MODEL,
            net,
          })
        : jevBackend({ apiKey, model: values.model ?? DEFAULT_JEV_MODEL, net }),
    spend: new SpendCap(maxSpend, {
      inputPerMTok: priceIn,
      outputPerMTok: priceOut,
    }),
    maxPairs,
    consent: values["consent-send"],
  };
}

/** The paid scorers: where each sends, and where its key and prices come from. */
const REMOTE = {
  llm: {
    origin: ANTHROPIC_ORIGIN,
    label: "Anthropic",
    keyEnv: "ANTHROPIC_API_KEY",
    auth: "anthropic",
    prices: "Anthropic's price list",
  },
  jev: {
    origin: JEV_ORIGIN,
    label: "Jev",
    keyEnv: "JEV_API_KEY",
    auth: "jev",
    prices: "docs.typesafe.ai/models",
  },
} as const;

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
    r.sent > 0
      ? `${(r.requestMs / r.sent).toFixed(0)} ms per request on average`
      : "",
    `${String(r.usage.inputTokens)} input and ${String(r.usage.outputTokens)} output tokens`,
    spend
      ? `$${spend.spentUsd.toFixed(4)} of your $${spend.capUsd.toFixed(2)} cap at your prices`
      : "",
  ];
  return parts.filter((p) => p !== "").join("; ");
}
