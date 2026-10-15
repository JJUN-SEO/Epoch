import { describe, expect, it } from "vitest";
import {
  RISK_BANDS,
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

  it("colors by risk band, folders by their riskiest file, unscored nodes neutral", () => {
    const g = {
      ...graph([]),
      nodes: [
        {
          ...node("src/a.ts"),
          metrics: { fanIn: 0, fanOut: 0, riskScore: 10 },
        },
        {
          ...node("src/b.ts"),
          metrics: { fanIn: 0, fanOut: 0, riskScore: 80 },
        },
        node("styles.css", "css"),
      ],
    };
    const c = nodeColors(g, "risk");
    expect(c.colorOf("src/a.ts", "typescript")).toBe(RISK_BANDS[0]?.color);
    expect(c.colorOf("src/b.ts", "typescript")).toBe(RISK_BANDS[3]?.color);
    expect(c.colorOf("src", undefined)).toBe(RISK_BANDS[3]?.color);
    expect(c.colorOf("styles.css", "css")).toBe(languageColor(undefined));
    expect(c.legend.at(-1)?.label).toBe("No score");
    expect(riskColor(25)).toBe(RISK_BANDS[1]?.color);
    expect(riskColor(100)).toBe(RISK_BANDS[3]?.color);
  });

  it("finds the top-level folder", () => {
    expect(topFolder("a/b/c.ts")).toBe("a");
    expect(topFolder("a")).toBe("");
    expect(topFolder("pkg:example.com/x")).toBe("pkg:example.com/x");
  });
});
