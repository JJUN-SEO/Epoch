import { describe, expect, it } from "vitest";
import {
  areSiblings,
  compareEdges,
  matchesAlias,
  scores,
  type ComparisonContext,
  type EpochImport,
  type ToolDependency,
} from "./edges.js";

const ctx: ComparisonContext = {
  workspacePackages: new Set(["@ws/lib"]),
  packages: [
    { name: "self", dir: "pkg", imports: ["#internal/*"] },
    { dir: "", imports: [] },
  ],
  otherAliases: [{ pattern: "@/*", dir: "docs" }],
};
const file = (
  from: string,
  specifier: string,
  target: string,
): EpochImport => ({
  from,
  specifier,
  kind: "static",
  res: { kind: "file", target },
});
const dep = (
  from: string,
  specifier: string,
  resolved: string | null,
  extra: Partial<ToolDependency> = {},
): ToolDependency => ({
  from,
  specifier,
  resolved,
  couldNotResolve: resolved === null,
  types: ["local", "import"],
  ...extra,
});

describe("matchesAlias / areSiblings", () => {
  it("matches tsconfig paths patterns", () => {
    expect(matchesAlias("@/components/x", "@/*")).toBe(true);
    expect(matchesAlias("@app", "@app")).toBe(true);
    expect(matchesAlias("lodash", "@/*")).toBe(false);
  });

  it("pairs a declaration or TS source with its JS file", () => {
    expect(areSiblings("a/x.d.ts", "a/x.js")).toBe(true);
    expect(areSiblings("a/x.js", "a/x.ts")).toBe(true);
    expect(areSiblings("w/y.wasm.d.ts", "w/y.wasm")).toBe(true);
    expect(areSiblings("a/x.ts", "a/y.js")).toBe(false);
    expect(areSiblings("a/x.d.ts", "a/x.ts")).toBe(false);
  });
});

describe("compareEdges", () => {
  const sources = new Set(["a.ts", "docs/page.ts", "pkg/t.ts"]);

  it("counts agreement and classifies each disagreement by rule", () => {
    const c = compareEdges({
      sources,
      epochImports: [
        file("a.ts", "./b", "b.ts"),
        file("a.ts", "@ws/lib", "lib/src/index.ts"),
        file("docs/page.ts", "@/x", "docs/x.ts"),
        file("pkg/t.ts", "self/sub", "pkg/sub.ts"),
        file("pkg/t.ts", "#internal/x", "pkg/src/x.ts"),
        file("a.ts", "#nope", "nope.ts"),
        file("a.ts", "./decl.js", "decl.d.ts"),
        {
          from: "a.ts",
          specifier: "./gone",
          kind: "static",
          res: { kind: "unresolved", reason: "not-found" },
        },
      ],
      toolDependencies: [
        dep("a.ts", "./b", "b.ts"),
        dep("a.ts", "@ws/lib", null),
        dep("docs/page.ts", "@/x", null),
        dep("pkg/t.ts", "self/sub", null),
        dep("pkg/t.ts", "#internal/x", null),
        dep("a.ts", "#nope", null),
        dep("a.ts", "./decl.js", "decl.js"),
        dep("a.ts", "./gone", "gone.mjs"),
        dep("a.ts", "./ref", "ref.d.ts", { types: ["triple-slash-directive"] }),
      ],
      context: ctx,
    });
    expect(c.both).toBe(1);
    const verdicts = c.disagreements.map(
      (d) => `${d.side} ${d.from}->${d.to} ${d.verdict}`,
    );
    expect(verdicts).toEqual([
      "epoch-only a.ts->decl.d.ts ambiguous",
      "tool-only a.ts->decl.js ambiguous",
      "tool-only a.ts->gone.mjs epoch-wrong",
      "epoch-only a.ts->lib/src/index.ts tool-wrong",
      "epoch-only a.ts->nope.ts unclassified",
      "tool-only a.ts->ref.d.ts epoch-wrong",
      "epoch-only docs/page.ts->docs/x.ts tool-wrong",
      "epoch-only pkg/t.ts->pkg/src/x.ts tool-wrong",
      "epoch-only pkg/t.ts->pkg/sub.ts tool-wrong",
    ]);
  });

  it("only applies a nested alias to files under its tsconfig", () => {
    const c = compareEdges({
      sources: new Set(["other/page.ts"]),
      epochImports: [file("other/page.ts", "@/x", "other/x.ts")],
      toolDependencies: [dep("other/page.ts", "@/x", null)],
      context: ctx,
    });
    expect(c.disagreements[0]?.verdict).toBe("unclassified");
  });
});

describe("scores", () => {
  it("leaves ambiguous edges out and counts unclassified ones against Epoch", () => {
    const s = scores({
      epochEdges: 10,
      toolEdges: 9,
      both: 8,
      disagreements: [
        {
          side: "epoch-only",
          from: "a",
          to: "b",
          specifiers: [],
          verdict: "tool-wrong",
          reason: "",
        },
        {
          side: "epoch-only",
          from: "a",
          to: "c",
          specifiers: [],
          verdict: "ambiguous",
          reason: "",
        },
        {
          side: "tool-only",
          from: "a",
          to: "d",
          specifiers: [],
          verdict: "unclassified",
          reason: "",
        },
      ],
    });
    expect(s.raw).toEqual({ precision: 0.8, recall: 8 / 9 });
    expect(s.adjusted).toEqual({ precision: 1, recall: 9 / 10 });
  });
});
