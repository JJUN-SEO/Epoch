import { z } from "zod";

/*
 * The app's settings (M7). Main stores them in Epoch's own data directory
 * and changes them only through updateSettings, so these schemas are the
 * boundary: a patch from the renderer is validated strictly, and a stored
 * file that is partly damaged costs only the damaged section.
 */

/** The default Claude model for model features: the current small model (the M6 scorer, M7 summaries). */
export const DEFAULT_CLAUDE_MODEL = "claude-haiku-5-5";

/** A model name: a Claude model id, or an Ollama tag such as "qwen3:4b". */
const ModelName = z
  .string()
  .regex(/^[A-Za-z0-9._:/-]{1,200}$/, "not a model name");

const usd = (max: number) => z.number().min(0).max(max);

/** USD per million tokens, as the user copied them from the provider's pricing page. None ship with Epoch. */
export const ModelPrice = z.strictObject({
  inputPerMTok: usd(1000),
  outputPerMTok: usd(1000),
});
export type ModelPrice = z.infer<typeof ModelPrice>;

/** "provider:model". Only paid providers have prices; a model on this machine costs nothing. */
const PriceKey = z
  .string()
  .regex(/^anthropic:[A-Za-z0-9._-]{1,100}$/, "must be anthropic:<model>");

const MAX_PRICES = 100;
const Prices = z
  .record(PriceKey, ModelPrice)
  .refine((r) => Object.keys(r).length <= MAX_PRICES, "too many prices");

/** The fields of each section, without defaults, so a patch can name a few. */
const summaryFields = {
  /** Model features are off until the user turns them on (CLAUDE.md). */
  enabled: z.boolean(),
  provider: z.enum(["anthropic", "local"]),
  /** The Claude model, for provider "anthropic". */
  model: ModelName,
  /** The Ollama model on this machine, for provider "local"; none until chosen. */
  localModel: ModelName.optional(),
  /** Summarize a file on open (after consent, within the limits below). */
  auto: z.boolean(),
};

const spendFields = {
  /** Required before any paid call; none until the user sets one. Resets monthly. */
  monthlyCapUsd: usd(10_000).optional(),
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
      auto: summaryFields.auto.default(true),
    })
    .prefault({}),
  prices: Prices.default({}),
  spend: z
    .object({
      ...spendFields,
      // Defaults to tune with use, like staleAfterDays; not claims.
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
 * removes the monthly cap or a price. Unknown keys are rejected.
 */
export const SettingsPatch = z.strictObject({
  offline: z.boolean().optional(),
  updateChecks: z.boolean().optional(),
  theme: sections.theme.unwrap().optional(),
  summaries: z.strictObject(summaryFields).partial().optional(),
  prices: z.record(PriceKey, ModelPrice.nullable()).optional(),
  spend: z
    .strictObject({
      ...spendFields,
      monthlyCapUsd: spendFields.monthlyCapUsd.unwrap().nullable(),
    })
    .partial()
    .optional(),
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
  const { monthlyCapUsd, ...spend } = defined(p.spend);
  const nextSpend: Record<string, unknown> = { ...current.spend, ...spend };
  if (monthlyCapUsd === null)
    Reflect.deleteProperty(nextSpend, "monthlyCapUsd");
  else if (monthlyCapUsd !== undefined) nextSpend.monthlyCapUsd = monthlyCapUsd;
  return Settings.parse({
    ...current,
    ...defined({
      offline: p.offline,
      updateChecks: p.updateChecks,
      theme: p.theme,
    }),
    summaries: { ...current.summaries, ...defined(p.summaries) },
    prices,
    spend: nextSpend,
  });
}

const dollars = (n: number | undefined): string =>
  n === undefined ? "none" : `$${n.toFixed(2)}`;

/**
 * The changes from `before` to `after` that let Epoch spend more: a higher
 * or first cap or budget, a higher ask-first threshold, a lower or new
 * price (a price set to zero would make every cap meaningless). Main asks
 * in a native dialog before saving any of them, so the renderer alone can
 * never raise what Epoch may spend.
 */
export function spendRaises(before: Settings, after: Settings): string[] {
  const out: string[] = [];
  const cap = [before.spend.monthlyCapUsd, after.spend.monthlyCapUsd] as const;
  if (cap[1] !== undefined && (cap[0] === undefined || cap[1] > cap[0]))
    out.push(`monthly cap ${dollars(cap[0])} → ${dollars(cap[1])}`);
  const limits = [
    ["session budget", "sessionBudgetUsd"],
    ["ask above", "confirmAboveUsd"],
  ] as const;
  for (const [label, key] of limits) {
    if (after.spend[key] > before.spend[key])
      out.push(
        `${label} ${dollars(before.spend[key])} → ${dollars(after.spend[key])}`,
      );
  }
  for (const [key, price] of Object.entries(after.prices)) {
    const old = before.prices[key];
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

/** The user's price for a provider's model, if they entered one. */
export const priceOf = (
  s: Settings,
  provider: string,
  model: string,
): ModelPrice | undefined => s.prices[`${provider}:${model}`];
