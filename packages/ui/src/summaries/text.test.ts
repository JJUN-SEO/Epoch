import { describe, expect, it } from "vitest";
import type { SummaryJobPlan } from "@epoch-dev/core";
import {
  FAILED_TEXT,
  UNAVAILABLE_TEXT,
  needsSettings,
  planText,
  staleText,
} from "./text";

const plan = (over: Partial<SummaryJobPlan> = {}): SummaryJobPlan => ({
  provider: "anthropic",
  model: "claude-haiku-5-5",
  destination: "https://api.anthropic.com",
  remote: true,
  requests: 1,
  sends: ["src/a.ts"],
  sendsMore: 0,
  excluded: [],
  estimate: { inputTokens: 1200, maxOutputTokens: 1024, worstCaseUsd: 0.0063 },
  ...over,
});

describe("summary texts", () => {
  it("has words for every reason, never a provider's message", () => {
    for (const t of [
      ...Object.values(UNAVAILABLE_TEXT),
      ...Object.values(FAILED_TEXT),
    ])
      expect(t.length).toBeGreaterThan(5);
    expect(needsSettings("no-key")).toBe(true);
    expect(needsSettings("secret")).toBe(false);
  });

  it("says what a plan sends, where, and the most it costs", () => {
    expect(planText(plan())).toEqual({
      what: "Sends 1 file to https://api.anthropic.com (claude-haiku-5-5) with your key.",
      cost: "At most $0.0063 at your prices.",
    });
    expect(
      planText(
        plan({
          requests: 5,
          sends: ["a", "b", "c"],
          sendsMore: 2,
          excluded: [".env"],
        }),
      ).what,
    ).toBe(
      "5 summaries. Sends 5 files to https://api.anthropic.com (claude-haiku-5-5) with your key. Never sent: .env.",
    );
    expect(
      planText(plan({ remote: false, provider: "local", model: "qwen3:4b" })),
    ).toEqual({
      what: "Runs on this machine (qwen3:4b); nothing leaves it.",
      cost: "Free.",
    });
  });

  it("says why a summary is out of date", () => {
    expect(staleText("file")).toContain("changed");
    expect(staleText("dependencies")).toContain("imports");
  });
});
