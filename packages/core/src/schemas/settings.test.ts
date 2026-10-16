import { describe, expect, it } from "vitest";
import {
  DEFAULT_CLAUDE_MODEL,
  DEFAULT_SETTINGS,
  SettingsPatch,
  applySettingsPatch,
  parseSettings,
  priceOf,
  spendRaises,
  updateChecksAllowed,
} from "./settings.js";

/*
 * App settings (M7). Stored by main in Epoch's own data directory, edited
 * through the typed API. A damaged file costs only the damaged section.
 */

describe("parseSettings", () => {
  it("gives the defaults for nothing stored: model features off, no cap", () => {
    for (const raw of [undefined, {}]) {
      const { settings, warnings } = parseSettings(raw);
      expect(settings).toEqual(DEFAULT_SETTINGS);
      expect(warnings).toEqual([]);
    }
    expect(DEFAULT_SETTINGS.offline).toBe(false);
    expect(DEFAULT_SETTINGS.summaries.enabled).toBe(false);
    expect(DEFAULT_SETTINGS.summaries.provider).toBe("anthropic");
    expect(DEFAULT_SETTINGS.summaries.model).toBe(DEFAULT_CLAUDE_MODEL);
    expect(DEFAULT_SETTINGS.spend.monthlyCapUsd).toBeUndefined();
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
    for (const prices of [
      { "claude-haiku-5-5": price },
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
      spend: { monthlyCapUsd: 5 },
    });
    expect(next.summaries).toEqual({
      ...DEFAULT_SETTINGS.summaries,
      enabled: true,
    });
    expect(next.spend).toEqual({ ...DEFAULT_SETTINGS.spend, monthlyCapUsd: 5 });
    expect(next.offline).toBe(DEFAULT_SETTINGS.offline);
  });

  it("removes a cap or a price with null", () => {
    const withBoth = applySettingsPatch(DEFAULT_SETTINGS, {
      spend: { monthlyCapUsd: 5 },
      prices: { "anthropic:m": { inputPerMTok: 1, outputPerMTok: 5 } },
    });
    const next = applySettingsPatch(withBoth, {
      spend: { monthlyCapUsd: null },
      prices: { "anthropic:m": null },
    });
    expect(next.spend.monthlyCapUsd).toBeUndefined();
    expect(next.spend).not.toHaveProperty("monthlyCapUsd");
    expect(next.prices).toEqual({});
  });

  it("rejects unknown keys and bad values, changing nothing", () => {
    for (const patch of [
      { telemetry: true },
      { summaries: { enabled: "yes" } },
      { summaries: { surprise: 1 } },
      { spend: { sessionBudgetUsd: Number.POSITIVE_INFINITY } },
      { prices: { "openai:m": { inputPerMTok: 1, outputPerMTok: 1 } } },
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

  it("counts a first cap and a new price as raises, lowering and removing as not", () => {
    expect(
      spendRaises(
        DEFAULT_SETTINGS,
        applySettingsPatch(DEFAULT_SETTINGS, { spend: { monthlyCapUsd: 1 } }),
      ),
    ).toEqual(["monthly cap none → $1.00"]);
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
    const lower = applySettingsPatch(base, {
      spend: { monthlyCapUsd: null, sessionBudgetUsd: 0.5 },
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

  it("finds the price of a provider's model", () => {
    const s = applySettingsPatch(DEFAULT_SETTINGS, {
      prices: { "anthropic:m": { inputPerMTok: 1, outputPerMTok: 5 } },
    });
    expect(priceOf(s, "anthropic", "m")).toEqual({
      inputPerMTok: 1,
      outputPerMTok: 5,
    });
    expect(priceOf(s, "anthropic", "other")).toBeUndefined();
  });
});
