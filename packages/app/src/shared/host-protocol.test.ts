import { describe, expect, it } from "vitest";
import { HostRequest, SummarySubject } from "./host-protocol";

describe("SummarySubject", () => {
  it.each(["src/a.ts", "pkg:example.com/m/a", "dir:", "dir:src/lib"])(
    "accepts %s",
    (s) => {
      expect(SummarySubject.safeParse(s).success).toBe(true);
    },
  );

  it.each([
    "",
    "/etc/passwd",
    "../x.ts",
    "C:/x.ts",
    "dir:../up",
    "dir:/abs",
    "pkg:",
    "pkg:a\\b",
    "src//a.ts",
  ])("refuses %j", (s) => {
    expect(SummarySubject.safeParse(s).success).toBe(false);
  });
});

describe("summary requests", () => {
  it("accepts a plan request and refuses an unknown provider or a long answer", () => {
    const plan = {
      type: "summary-plan",
      id: 1,
      root: "/p",
      subject: "src/a.ts",
      model: { provider: "anthropic", model: "claude-haiku-5-5" },
      withPrompt: true,
    };
    expect(HostRequest.safeParse(plan).success).toBe(true);
    expect(
      HostRequest.safeParse({
        ...plan,
        model: { provider: "openai", model: "x" },
      }).success,
    ).toBe(false);
    const store = {
      type: "summary-store",
      id: 2,
      root: "/p",
      key: "a".repeat(64),
      answer: { text: "Prose.", inputTokens: 1, outputTokens: 1, costUsd: 0 },
    };
    expect(HostRequest.safeParse(store).success).toBe(true);
    expect(
      HostRequest.safeParse({
        ...store,
        answer: { ...store.answer, text: "x".repeat(70_000) },
      }).success,
    ).toBe(false);
  });
});
