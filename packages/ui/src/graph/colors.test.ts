import { describe, expect, it } from "vitest";
import {
  COVERAGE_COLORS,
  RISK_TIER_COLORS,
  coverageColor,
  languageColor,
  nodeColors,
  riskColor,
  topFolder,
} from "./colors";
import { graph, node } from "./test-graph";

describe("node colors", () => {
  it("colors by top-level folder, stably, with root files neutral", () => {
    const g = graph(["src/a.ts", "src/x/b.ts", "lib/c.ts", "top.ts"]);
    const c = nodeColors(g, "folder");
    expect(c.legend.map((l) => l.label)).toEqual(["lib/", "src/"]);
    expect(c.colorOf("src/a.ts", "typescript")).toBe(
      c.colorOf("src/x/b.ts", "typescript"),
    );
    expect(c.colorOf("src/a.ts", undefined)).not.toBe(
      c.colorOf("lib/c.ts", undefined),
    );
    expect(c.colorOf("top.ts", "typescript")).toBe(languageColor(undefined));
  });

  it("colors by language when asked", () => {
    const g = graph(["a.ts"]);
    const c = nodeColors(g, "language");
    expect(c.colorOf("a.ts", "typescript")).toBe(languageColor("typescript"));
    expect(c.legend).toEqual([
      { label: "typescript", color: languageColor("typescript") },
    ]);
  });

  it("colors by risk tier, folders by their riskiest file, untiered nodes neutral", () => {
    const g = {
      ...graph([]),
      nodes: [
        {
          ...node("src/a.ts"),
          metrics: {
            fanIn: 0,
            fanOut: 0,
            risk: { tier: "low" as const, archetype: "stable-leaf" as const },
          },
        },
        {
          ...node("src/b.ts"),
          metrics: {
            fanIn: 0,
            fanOut: 0,
            risk: {
              tier: "high" as const,
              archetype: "active-hotspot" as const,
            },
          },
        },
        node("styles.css", "css"),
      ],
    };
    const c = nodeColors(g, "risk");
    expect(c.colorOf("src/a.ts", "typescript")).toBe(RISK_TIER_COLORS.low);
    expect(c.colorOf("src/b.ts", "typescript")).toBe(RISK_TIER_COLORS.high);
    expect(c.colorOf("src", undefined)).toBe(RISK_TIER_COLORS.high);
    expect(c.colorOf("styles.css", "css")).toBe(languageColor(undefined));
    expect(c.legend.map((l) => l.label)).toEqual([
      "Critical",
      "High",
      "Moderate",
      "Low–moderate",
      "Low",
      "No tier",
    ]);
    expect(riskColor(undefined)).toBe(languageColor(undefined));
  });

  it("colors by coverage, folders by their files' covered lines, uncovered nodes neutral", () => {
    const covered = (id: string, coverage: number, loc: number) => ({
      ...node(id),
      loc,
      metrics: { fanIn: 0, fanOut: 0, coverage },
    });
    const g = {
      ...graph([]),
      nodes: [
        covered("src/a.ts", 0.9, 100),
        covered("src/b.ts", 0.2, 300),
        covered("lib/c.ts", 0.6, 10),
        node("lib/d.ts"),
      ],
    };
    const c = nodeColors(g, "coverage");
    expect(c.colorOf("src/a.ts", "typescript")).toBe(coverageColor(0.9));
    expect(coverageColor(0.9)).toBe(COVERAGE_COLORS.high);
    expect(c.colorOf("src/b.ts", "typescript")).toBe(COVERAGE_COLORS.low);
    expect(c.colorOf("lib/c.ts", "typescript")).toBe(COVERAGE_COLORS.medium);
    expect(c.colorOf("lib/d.ts", "typescript")).toBe(languageColor(undefined));
    // src: (90 + 60) of 400 lines run = 37.5%; lib counts only its covered file.
    expect(c.colorOf("src", undefined)).toBe(COVERAGE_COLORS.low);
    expect(c.colorOf("lib", undefined)).toBe(COVERAGE_COLORS.medium);
    expect(c.colorOf("docs", undefined)).toBe(languageColor(undefined));
    expect(c.legend.map((l) => l.label)).toEqual([
      "80% or more",
      "50–79%",
      "Under 50%",
      "No coverage",
    ]);
    // The boundaries: 50% is where a file stops being fragile.
    expect(coverageColor(0.5)).toBe(COVERAGE_COLORS.medium);
    expect(coverageColor(0.8)).toBe(COVERAGE_COLORS.high);
    expect(coverageColor(undefined)).toBe(languageColor(undefined));
  });

  it("finds the top-level folder", () => {
    expect(topFolder("a/b/c.ts")).toBe("a");
    expect(topFolder("a")).toBe("");
    expect(topFolder("pkg:example.com/x")).toBe("pkg:example.com/x");
  });
});
