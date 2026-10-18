import { describe, expect, it } from "vitest";
import {
  DEFAULT_CLAUDE_MODEL,
  DEFAULT_MODELS,
  DEFAULT_MONTHLY_CAP_USD,
  DEFAULT_SETTINGS,
  SHIPPED_PRICES,
  SettingsPatch,
  applySettingsPatch,
  parseSettings,
  priceOf,
  remoteModelOf,
  spendRaises,
  updateChecksAllowed,
} from "./settings.js";

/*
 * App settings (M7). Stored by main in Epoch's own data directory, edited
 * through the typed API. A damaged file costs only the damaged section.
 */

describe("parseSettings", () => {
  it("gives the defaults for nothing stored: model features off, a monthly cap", () => {
    for (const raw of [undefined, {}]) {
      const { settings, warnings } = parseSettings(raw);
      expect(settings).toEqual(DEFAULT_SETTINGS);
      expect(warnings).toEqual([]);
    }
    expect(DEFAULT_SETTINGS.offline).toBe(false);
    expect(DEFAULT_SETTINGS.summaries.enabled).toBe(false);
    expect(DEFAULT_SETTINGS.summaries.provider).toBe("anthropic");
    expect(DEFAULT_SETTINGS.summaries.model).toBe(DEFAULT_CLAUDE_MODEL);
    expect(DEFAULT_SETTINGS.summaries.openaiModel).toBe(DEFAULT_MODELS.openai);
    expect(DEFAULT_SETTINGS.summaries.geminiModel).toBe(DEFAULT_MODELS.gemini);
    expect(DEFAULT_SETTINGS.spend.monthlyCapUsd).toBe(DEFAULT_MONTHLY_CAP_USD);
    expect(DEFAULT_SETTINGS.prices).toEqual({});
  });

  it("falls back one section at a time", () => {
    const { settings, warnings } = parseSettings({
      offline: true,
      spend: { monthlyCapUsd: -5 },
      summaries: { enabled: true, provider: "local", localModel: "qwen3:4b" },
    });
    expect(settings.offline).toBe(true);
    expect(settings.spend).toEqual(DEFAULT_SETTINGS.spend);
    expect(settings.summaries).toMatchObject({
      enabled: true,
      provider: "local",
      localModel: "qwen3:4b",
    });
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/^spend: .*; using defaults$/);
  });

  it("keeps settings stored before OpenAI and Gemini, and picks each provider's model", () => {
    const { settings, warnings } = parseSettings({
      summaries: { enabled: true, provider: "anthropic", model: "claude-x" },
    });
    expect(warnings).toEqual([]);
    expect(settings.summaries.openaiModel).toBe(DEFAULT_MODELS.openai);
    expect(remoteModelOf(settings, "anthropic")).toBe("claude-x");
    const other = applySettingsPatch(settings, {
      summaries: {
        provider: "gemini",
        geminiModel: "gemini-y",
        openaiModel: "gpt-z",
      },
    });
    expect(other.summaries.provider).toBe("gemini");
    expect(remoteModelOf(other, "gemini")).toBe("gemini-y");
    expect(remoteModelOf(other, "openai")).toBe("gpt-z");
    expect(
      parseSettings({ summaries: { provider: "mistral" } }).warnings[0],
    ).toMatch(/^summaries: provider/);
  });

  it("drops unknown settings, and anything that is not an object", () => {
    let r = parseSettings({ offline: true, telemetry: true });
    expect(r.settings.offline).toBe(true);
    expect(r.settings).not.toHaveProperty("telemetry");
    expect(r.warnings).toEqual(["telemetry: unknown setting, ignored"]);
    for (const raw of ["x", [], null, 3]) {
      r = parseSettings(raw);
      expect(r.settings).toEqual(DEFAULT_SETTINGS);
      expect(r.warnings).toEqual(["settings: not an object; using defaults"]);
    }
  });

  it("accepts prices per provider and model, and nothing else", () => {
    const price = { inputPerMTok: 1, outputPerMTok: 5 };
    expect(
      parseSettings({ prices: { "anthropic:claude-haiku-5-5": price } })
        .settings.prices,
    ).toEqual({ "anthropic:claude-haiku-5-5": price });
    expect(
      parseSettings({
        prices: {
          "openai:gpt-6-luna": price,
          "gemini:gemini-3.1-flash-lite": price,
        },
      }).settings.prices,
    ).toEqual({
      "openai:gpt-6-luna": price,
      "gemini:gemini-3.1-flash-lite": price,
    });
    for (const prices of [
      { "claude-haiku-5-5": price },
      { "local:qwen3": price },
      { "mistral:m": price },
      { "anthropic:claude haiku": price },
      { "anthropic:m": { inputPerMTok: -1, outputPerMTok: 5 } },
      { "anthropic:m": { inputPerMTok: 1 } },
    ]) {
      const r = parseSettings({ prices });
      expect(r.settings.prices).toEqual({});
      expect(r.warnings[0]).toMatch(/^prices: /);
    }
  });
});

describe("applySettingsPatch", () => {
  it("changes only what the patch names, inside a section too", () => {
    const next = applySettingsPatch(DEFAULT_SETTINGS, {
      summaries: { enabled: true },
      spend: { monthlyCapUsd: 10 },
    });
    expect(next.summaries).toEqual({
      ...DEFAULT_SETTINGS.summaries,
      enabled: true,
    });
    expect(next.spend).toEqual({
      ...DEFAULT_SETTINGS.spend,
      monthlyCapUsd: 10,
    });
    expect(next.offline).toBe(DEFAULT_SETTINGS.offline);
  });

  it("removes the user's price with null; the cap can be changed, not removed", () => {
    const priced = applySettingsPatch(DEFAULT_SETTINGS, {
      prices: { "anthropic:m": { inputPerMTok: 1, outputPerMTok: 5 } },
    });
    expect(
      applySettingsPatch(priced, { prices: { "anthropic:m": null } }).prices,
    ).toEqual({});
    expect(
      SettingsPatch.safeParse({ spend: { monthlyCapUsd: null } }).success,
    ).toBe(false);
  });

  it("rejects unknown keys and bad values, changing nothing", () => {
    for (const patch of [
      { telemetry: true },
      { summaries: { enabled: "yes" } },
      { summaries: { surprise: 1 } },
      { spend: { sessionBudgetUsd: Number.POSITIVE_INFINITY } },
      { prices: { "mistral:m": { inputPerMTok: 1, outputPerMTok: 1 } } },
    ]) {
      expect(SettingsPatch.safeParse(patch).success).toBe(false);
      expect(() => applySettingsPatch(DEFAULT_SETTINGS, patch)).toThrow();
    }
  });
});

describe("spendRaises", () => {
  const base = applySettingsPatch(DEFAULT_SETTINGS, {
    spend: { monthlyCapUsd: 5, sessionBudgetUsd: 1, confirmAboveUsd: 0.05 },
    prices: { "anthropic:m": { inputPerMTok: 1, outputPerMTok: 5 } },
  });

  it("lists every change that lets Epoch spend more", () => {
    const next = applySettingsPatch(base, {
      spend: { monthlyCapUsd: 10, sessionBudgetUsd: 2, confirmAboveUsd: 1 },
      prices: { "anthropic:m": { inputPerMTok: 0, outputPerMTok: 5 } },
    });
    expect(spendRaises(base, next)).toEqual([
      "monthly cap $5.00 → $10.00",
      "session budget $1.00 → $2.00",
      "ask above $0.05 → $1.00",
      "anthropic:m input price $1.00 → $0.00 per million tokens",
    ]);
  });

  it("counts a first price and any lower price in effect as raises, lowering and removing as not", () => {
    expect(
      spendRaises(
        base,
        applySettingsPatch(base, {
          prices: { "anthropic:n": { inputPerMTok: 1, outputPerMTok: 5 } },
        }),
      ),
    ).toEqual([
      "anthropic:n price set: $1.00 in, $5.00 out per million tokens",
    ]);
    // Below the price Epoch ships for the default model.
    const key = `anthropic:${DEFAULT_CLAUDE_MODEL}`;
    const cheaper = applySettingsPatch(base, {
      prices: { [key]: { inputPerMTok: 0.05, outputPerMTok: 0.5 } },
    });
    expect(spendRaises(base, cheaper)).toEqual([
      `${key} input price $0.10 → $0.05 per million tokens`,
    ]);
    // Removing a price above the shipped one falls back to it: a raise.
    const dearer = applySettingsPatch(base, {
      prices: { [key]: { inputPerMTok: 1, outputPerMTok: 5 } },
    });
    expect(spendRaises(base, dearer)).toEqual([]);
    expect(
      spendRaises(
        dearer,
        applySettingsPatch(dearer, { prices: { [key]: null } }),
      ),
    ).toEqual([
      `${key} input price $1.00 → $0.10 per million tokens`,
      `${key} output price $5.00 → $0.50 per million tokens`,
    ]);
    const lower = applySettingsPatch(base, {
      spend: { monthlyCapUsd: 2, sessionBudgetUsd: 0.5 },
      prices: { "anthropic:m": { inputPerMTok: 2, outputPerMTok: 6 } },
    });
    expect(spendRaises(base, lower)).toEqual([]);
    expect(spendRaises(base, base)).toEqual([]);
  });
});

describe("helpers", () => {
  it("never checks for updates while offline", () => {
    expect(updateChecksAllowed(DEFAULT_SETTINGS)).toBe(true);
    expect(
      updateChecksAllowed(
        applySettingsPatch(DEFAULT_SETTINGS, { offline: true }),
      ),
    ).toBe(false);
    expect(
      updateChecksAllowed(
        applySettingsPatch(DEFAULT_SETTINGS, { updateChecks: false }),
      ),
    ).toBe(false);
  });

  it("finds the price in effect: the user's, else the shipped one", () => {
    const s = applySettingsPatch(DEFAULT_SETTINGS, {
      prices: { "anthropic:m": { inputPerMTok: 1, outputPerMTok: 5 } },
    });
    expect(priceOf(s, "anthropic", "m")).toEqual({
      inputPerMTok: 1,
      outputPerMTok: 5,
    });
    expect(priceOf(s, "anthropic", "other")).toBeUndefined();
    // A key is all a user needs for the default model.
    expect(
      priceOf(DEFAULT_SETTINGS, "anthropic", DEFAULT_CLAUDE_MODEL),
    ).toEqual(SHIPPED_PRICES[`anthropic:${DEFAULT_CLAUDE_MODEL}`]);
    expect(SHIPPED_PRICES[`anthropic:${DEFAULT_CLAUDE_MODEL}`]).toEqual({
      inputPerMTok: 0.1,
      outputPerMTok: 0.5,
    });
    // Each read from its provider's pricing page on 2026-10-17 (ADR-019).
    expect(priceOf(DEFAULT_SETTINGS, "openai", DEFAULT_MODELS.openai)).toEqual({
      inputPerMTok: 0.1,
      outputPerMTok: 0.5,
    });
    expect(priceOf(DEFAULT_SETTINGS, "gemini", DEFAULT_MODELS.gemini)).toEqual({
      inputPerMTok: 0.25,
      outputPerMTok: 1.5,
    });
  });
});
