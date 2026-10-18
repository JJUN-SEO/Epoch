import { z } from "zod";

/*
 * The app's settings (M7). Main stores them in Epoch's own data directory
 * and changes them only through updateSettings, so these schemas are the
 * boundary: a patch from the renderer is validated strictly, and a stored
 * file that is partly damaged costs only the damaged section.
 */

/** The default Claude model for model features: the current small model (the M6 scorer, M7 summaries). */
export const DEFAULT_CLAUDE_MODEL = "claude-haiku-5-5";

/**
 * Providers that summarize with the user's own key, off this machine
 * (ADR-016, ADR-019). Each key goes only to its own provider.
 */
export const REMOTE_PROVIDERS = ["anthropic", "openai", "gemini"] as const;
export type RemoteProvider = (typeof REMOTE_PROVIDERS)[number];

/** Who writes summaries: a remote provider, or the model on this machine. */
export const SummaryProvider = z.enum([...REMOTE_PROVIDERS, "local"]);
export type SummaryProvider = z.infer<typeof SummaryProvider>;

export const isRemoteProvider = (p: string): p is RemoteProvider =>
  (REMOTE_PROVIDERS as readonly string[]).includes(p);

/**
 * Each remote provider's default summary model: its current small,
 * low-cost text model, from its own models page on 2026-10-17
 * (https://developers.openai.com/api/docs/models,
 * https://ai.google.dev/gemini-api/docs/models).
 */
export const DEFAULT_MODELS: Readonly<Record<RemoteProvider, string>> =
  Object.freeze({
    anthropic: DEFAULT_CLAUDE_MODEL,
    openai: "gpt-6-luna",
    gemini: "gemini-3.1-flash-lite",
  });

/** A model name: a provider's model id, or an Ollama tag such as "qwen3:4b". */
const ModelName = z
  .string()
  .regex(/^[A-Za-z0-9._:/-]{1,200}$/, "not a model name");

const usd = (max: number) => z.number().min(0).max(max);

/** USD per million tokens. */
export const ModelPrice = z.strictObject({
  inputPerMTok: usd(1000),
  outputPerMTok: usd(1000),
});
export type ModelPrice = z.infer<typeof ModelPrice>;

/**
 * Prices that ship with Epoch, so a key is all a user needs: each default
 * model's, copied from its provider's pricing page on the date below (never
 * from memory). The user's own price for a model replaces it. Summary
 * prompts stay far under the lengths above which these models cost more
 * (100,000 tokens for Claude Haiku 5.5, 272,000 for GPT-6 Luna); Gemini's
 * price is its paid tier, standard processing.
 */
export const SHIPPED_PRICES: Readonly<Record<string, ModelPrice>> =
  Object.freeze({
    [`anthropic:${DEFAULT_MODELS.anthropic}`]: {
      inputPerMTok: 0.1,
      outputPerMTok: 0.5,
    },
    [`openai:${DEFAULT_MODELS.openai}`]: {
      inputPerMTok: 0.1,
      outputPerMTok: 0.5,
    },
    [`gemini:${DEFAULT_MODELS.gemini}`]: {
      inputPerMTok: 0.25,
      outputPerMTok: 1.5,
    },
  });

/** Each provider's pricing page, its name for the UI, and when its shipped price was read. */
export const PROVIDER_INFO: Readonly<
  Record<RemoteProvider, { label: string; pricingUrl: string; readOn: string }>
> = Object.freeze({
  anthropic: {
    label: "Anthropic",
    pricingUrl: "https://platform.claude.com/docs/en/about-claude/pricing",
    readOn: "2026-10-17",
  },
  openai: {
    label: "OpenAI",
    pricingUrl: "https://developers.openai.com/api/docs/pricing",
    readOn: "2026-10-17",
  },
  gemini: {
    label: "Google Gemini",
    pricingUrl: "https://ai.google.dev/gemini-api/docs/pricing",
    readOn: "2026-10-17",
  },
});

/** The monthly cap until the user sets another; a default to tune with use, not a claim. */
export const DEFAULT_MONTHLY_CAP_USD = 5;

/** "provider:model". Only paid providers have prices; a model on this machine costs nothing. */
const PriceKey = z
  .string()
  .regex(
    /^(anthropic|openai|gemini):[A-Za-z0-9._-]{1,100}$/,
    "must be <anthropic|openai|gemini>:<model>",
  );

const MAX_PRICES = 100;
const Prices = z
  .record(PriceKey, ModelPrice)
  .refine((r) => Object.keys(r).length <= MAX_PRICES, "too many prices");

/** The fields of each section, without defaults, so a patch can name a few. */
const summaryFields = {
  /** Model features are off until the user turns them on (CLAUDE.md). */
  enabled: z.boolean(),
  provider: SummaryProvider,
  /** The Claude model, for provider "anthropic". */
  model: ModelName,
  /** The OpenAI model, for provider "openai". */
  openaiModel: ModelName,
  /** The Gemini model, for provider "gemini". */
  geminiModel: ModelName,
  /** The Ollama model on this machine, for provider "local"; none until chosen. */
  localModel: ModelName.optional(),
  /** Summarize a file on open (after consent, within the limits below). */
  auto: z.boolean(),
};

const spendFields = {
  /** What paid requests may spend in a calendar month. */
  monthlyCapUsd: usd(10_000),
  /** What one app session may spend. */
  sessionBudgetUsd: usd(10_000),
  /** A job estimated above this asks first; auto summaries never run above it. */
  confirmAboveUsd: usd(1_000),
};

const sections = {
  offline: z.boolean().default(false),
  /** The update check itself arrives in M8; offline mode always turns it off. */
  updateChecks: z.boolean().default(true),
  theme: z.enum(["system", "light", "dark"]).default("system"),
  summaries: z
    .object({
      ...summaryFields,
      enabled: summaryFields.enabled.default(false),
      provider: summaryFields.provider.default("anthropic"),
      model: summaryFields.model.default(DEFAULT_CLAUDE_MODEL),
      openaiModel: summaryFields.openaiModel.default(DEFAULT_MODELS.openai),
      geminiModel: summaryFields.geminiModel.default(DEFAULT_MODELS.gemini),
      auto: summaryFields.auto.default(true),
    })
    .prefault({}),
  prices: Prices.default({}),
  spend: z
    .object({
      ...spendFields,
      // Defaults to tune with use, like staleAfterDays; not claims.
      monthlyCapUsd: spendFields.monthlyCapUsd.default(DEFAULT_MONTHLY_CAP_USD),
      sessionBudgetUsd: spendFields.sessionBudgetUsd.default(1),
      confirmAboveUsd: spendFields.confirmAboveUsd.default(0.05),
    })
    .prefault({}),
};

export const Settings = z.object(sections);
export type Settings = z.infer<typeof Settings>;

export const DEFAULT_SETTINGS: Settings = Object.freeze(Settings.parse({}));

/**
 * A change from the renderer: any setting, any field of a section; null
 * removes the user's price for a model. Unknown keys are rejected.
 */
export const SettingsPatch = z.strictObject({
  offline: z.boolean().optional(),
  updateChecks: z.boolean().optional(),
  theme: sections.theme.unwrap().optional(),
  summaries: z.strictObject(summaryFields).partial().optional(),
  prices: z.record(PriceKey, ModelPrice.nullable()).optional(),
  spend: z.strictObject(spendFields).partial().optional(),
});
export type SettingsPatch = z.input<typeof SettingsPatch>;

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * Stored settings, each section checked on its own: a section that fails
 * takes its defaults and adds a warning; unknown keys are dropped.
 */
export function parseSettings(raw: unknown): {
  settings: Settings;
  warnings: string[];
} {
  const warnings: string[] = [];
  let input: Record<string, unknown> = {};
  if (isRecord(raw)) input = raw;
  else if (raw !== undefined)
    warnings.push("settings: not an object; using defaults");
  const out: Record<string, unknown> = {};
  for (const [key, schema] of Object.entries(sections)) {
    const r = schema.safeParse(input[key]);
    if (r.success) {
      out[key] = r.data;
    } else {
      const issue = r.error.issues[0];
      const where =
        issue && issue.path.length > 0 ? `${issue.path.join(".")}: ` : "";
      warnings.push(
        `${key}: ${where}${issue?.message ?? "invalid"}; using defaults`,
      );
      out[key] = schema.parse(undefined);
    }
  }
  for (const key of Object.keys(input)) {
    if (!Object.hasOwn(sections, key))
      warnings.push(`${key}: unknown setting, ignored`);
  }
  return { settings: Settings.parse(out), warnings };
}

/** Fields the patch names, without the ones it leaves undefined. */
function defined<T extends object>(o: T | undefined): Partial<T> {
  return Object.fromEntries(
    Object.entries(o ?? {}).filter(([, v]) => v !== undefined),
  ) as Partial<T>;
}

/** The settings after a patch. Throws (a ZodError) on an invalid patch, changing nothing. */
export function applySettingsPatch(
  current: Settings,
  patch: unknown,
): Settings {
  const p = SettingsPatch.parse(patch);
  const prices: Record<string, ModelPrice> = { ...current.prices };
  for (const [key, price] of Object.entries(p.prices ?? {})) {
    if (price === null) Reflect.deleteProperty(prices, key);
    else prices[key] = price;
  }
  return Settings.parse({
    ...current,
    ...defined({
      offline: p.offline,
      updateChecks: p.updateChecks,
      theme: p.theme,
    }),
    summaries: { ...current.summaries, ...defined(p.summaries) },
    prices,
    spend: { ...current.spend, ...defined(p.spend) },
  });
}

const dollars = (n: number): string => `$${n.toFixed(2)}`;

/**
 * The changes from `before` to `after` that let Epoch spend more: a higher
 * cap or budget, a higher ask-first threshold, a lower or first price for a
 * model (a price set to zero would make every cap meaningless), comparing
 * the prices in effect, shipped or the user's. Main asks
 * in a native dialog before saving any of them, so the renderer alone can
 * never raise what Epoch may spend.
 */
export function spendRaises(before: Settings, after: Settings): string[] {
  const out: string[] = [];
  const limits = [
    ["monthly cap", "monthlyCapUsd"],
    ["session budget", "sessionBudgetUsd"],
    ["ask above", "confirmAboveUsd"],
  ] as const;
  for (const [label, key] of limits) {
    if (after.spend[key] > before.spend[key])
      out.push(
        `${label} ${dollars(before.spend[key])} → ${dollars(after.spend[key])}`,
      );
  }
  const keys = new Set([
    ...Object.keys(SHIPPED_PRICES),
    ...Object.keys(before.prices),
    ...Object.keys(after.prices),
  ]);
  for (const key of [...keys].sort()) {
    const price = after.prices[key] ?? SHIPPED_PRICES[key];
    const old = before.prices[key] ?? SHIPPED_PRICES[key];
    if (price === undefined) continue;
    if (old === undefined) {
      out.push(
        `${key} price set: ${dollars(price.inputPerMTok)} in, ${dollars(price.outputPerMTok)} out per million tokens`,
      );
      continue;
    }
    for (const [label, field] of [
      ["input", "inputPerMTok"],
      ["output", "outputPerMTok"],
    ] as const) {
      if (price[field] < old[field])
        out.push(
          `${key} ${label} price ${dollars(old[field])} → ${dollars(price[field])} per million tokens`,
        );
    }
  }
  return out;
}

/** Whether Epoch may check for updates: never in offline mode. */
export const updateChecksAllowed = (s: Settings): boolean =>
  s.updateChecks && !s.offline;

/** The price in effect for a provider's model: the user's, else the one Epoch ships. */
export const priceOf = (
  s: Settings,
  provider: string,
  model: string,
): ModelPrice | undefined =>
  s.prices[`${provider}:${model}`] ?? SHIPPED_PRICES[`${provider}:${model}`];

/** The model a remote provider would summarize with, as the settings name it. */
export const remoteModelOf = (s: Settings, provider: RemoteProvider): string =>
  provider === "openai"
    ? s.summaries.openaiModel
    : provider === "gemini"
      ? s.summaries.geminiModel
      : s.summaries.model;
