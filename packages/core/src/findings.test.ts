import { describe, expect, it } from "vitest";
import { atLeast, byConfidence, filterFindings } from "./findings.js";
import {
  DEFAULT_EPOCH_CONFIG,
  EpochConfig,
  type Finding,
} from "./schemas/index.js";

const finding = (
  id: string,
  kind: Finding["kind"],
  confidence: Finding["confidence"],
): Finding => ({
  id,
  kind,
  subject: { type: "file", name: `${id}.ts` },
  confidence,
  locations: [{ file: `${id}.ts` }],
  evidence: ["e"],
  caveats: ["c"],
  suggestedAction: "s",
  caps: [],
});

describe("filterFindings", () => {
  const all = [
    finding("a", "unreachable-file", "high"),
    finding("b", "dead-branch", "medium"),
    finding("c", "stale-flag", "low"),
  ];

  it("filters by kind and minimum confidence, keeping order", () => {
    expect(
      filterFindings(all, { minConfidence: "medium" }).map((f) => f.id),
    ).toEqual(["a", "b"]);
    expect(
      filterFindings(all, { kinds: ["stale-flag"] }).map((f) => f.id),
    ).toEqual(["c"]);
    expect(filterFindings(all).map((f) => f.id)).toEqual(["a", "b", "c"]);
  });

  it("leaves dismissed findings out unless asked", () => {
    const dismissed = new Set(["a"]);
    expect(filterFindings(all, {}, dismissed).map((f) => f.id)).toEqual([
      "b",
      "c",
    ]);
    expect(
      filterFindings(all, { includeDismissed: true }, dismissed).map(
        (f) => f.id,
      ),
    ).toEqual(["a", "b", "c"]);
  });

  it("orders confidence levels", () => {
    expect(atLeast("high", "medium")).toBe(true);
    expect(atLeast("low", "medium")).toBe(false);
    expect(
      ["low", "high", "medium"].sort((a, b) =>
        byConfidence(a as Finding["confidence"], b as Finding["confidence"]),
      ),
    ).toEqual(["high", "medium", "low"]);
  });
});

describe("EpochConfig", () => {
  it("fills every default from an empty object", () => {
    expect(DEFAULT_EPOCH_CONFIG).toEqual({
      entryPoints: [],
      ignore: [],
      flags: {
        wrapperFunctions: [],
        envPrefixes: [],
        longLived: [],
        staleAfterDays: 90,
      },
      findings: { minConfidence: "medium", ignore: [] },
    });
  });

  it("accepts the CLAUDE.md example and rejects bad values", () => {
    const example = {
      entryPoints: ["src/main.ts", "scripts/**"],
      ignore: ["**/generated/**"],
      flags: {
        wrapperFunctions: ["featureEnabled"],
        envPrefixes: ["FEATURE_", "ENABLE_"],
        longLived: ["payments-kill-switch"],
        staleAfterDays: 90,
      },
      findings: { minConfidence: "medium", ignore: ["legacy/**"] },
    };
    expect(EpochConfig.parse(example)).toEqual(example);
    expect(
      EpochConfig.safeParse({ flags: { staleAfterDays: 0 } }).success,
    ).toBe(false);
    expect(
      EpochConfig.safeParse({ flags: { wrapperFunctions: ["a(b)"] } }).success,
    ).toBe(false);
    expect(
      EpochConfig.safeParse({ findings: { minConfidence: "certain" } }).success,
    ).toBe(false);
  });
});
