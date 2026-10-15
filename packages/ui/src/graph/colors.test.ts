import { describe, expect, it } from "vitest";
import { languageColor, nodeColors, topFolder } from "./colors";
import { graph } from "./test-graph";

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

  it("finds the top-level folder", () => {
    expect(topFolder("a/b/c.ts")).toBe("a");
    expect(topFolder("a")).toBe("");
    expect(topFolder("pkg:example.com/x")).toBe("pkg:example.com/x");
  });
});
