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
  workspacePackages: new Map([
    [
      "@ws/lib",
      {
        dir: "lib",
        exports: {
          ".": { "@ws/source": "./src/index.ts", import: "./dist/index.js" },
          "./config": {
            "@ws/source": "./src/config.ts",
            types: "./config.d.ts",
          },
          "./locales/*": { "@ws/source": "./src/locales/*" },
        },
      },
    ],
  ]),
  packages: [
    { name: "self", dir: "pkg", imports: ["#internal/*"] },
    { dir: "", imports: [] },
  ],
  aliases: [
    { pattern: "@/*", dir: "docs", baseUrl: false },
    { pattern: "~/*", dir: "site", baseUrl: true },
  ],
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

  it("accepts an unresolved workspace import only when Epoch's target is one of the package's own exports", () => {
    const c = compareEdges({
      sources: new Set(["a.ts", "b.ts"]),
      epochImports: [
        file("a.ts", "@ws/lib", "lib/src/index.ts"),
        file("b.ts", "@ws/lib", "lib/src/other.ts"),
      ],
      toolDependencies: [
        dep("a.ts", "@ws/lib", null),
        dep("b.ts", "@ws/lib", null),
      ],
      context: ctx,
    });
    expect(c.disagreements.map((d) => `${d.from} ${d.verdict}`)).toEqual([
      "a.ts tool-wrong",
      "b.ts unclassified",
    ]);
  });

  it("accepts TypeScript's .ts face of a .js export target", () => {
    const c = compareEdges({
      sources: new Set(["a.ts"]),
      epochImports: [
        file("a.ts", "@ws/lib/locales/fr.js", "lib/src/locales/fr.ts"),
      ],
      toolDependencies: [dep("a.ts", "@ws/lib/locales/fr.js", null)],
      context: ctx,
    });
    expect(c.disagreements[0]?.verdict).toBe("tool-wrong");
  });

  it("calls two different exports of one workspace subpath ambiguous", () => {
    const c = compareEdges({
      sources: new Set(["a.ts"]),
      epochImports: [file("a.ts", "@ws/lib/config", "lib/config.d.ts")],
      toolDependencies: [dep("a.ts", "@ws/lib/config", "lib/src/config.ts")],
      context: ctx,
    });
    expect(c.disagreements.map((d) => `${d.side} ${d.verdict}`)).toEqual([
      "epoch-only ambiguous",
      "tool-only ambiguous",
    ]);
  });

  it("names a paths alias without baseUrl as the tool's limit, and leaves one with baseUrl for review", () => {
    const c = compareEdges({
      sources: new Set(["docs/page.ts", "site/page.ts"]),
      epochImports: [
        file("docs/page.ts", "@/x", "docs/x.ts"),
        file("site/page.ts", "~/x", "site/x.ts"),
      ],
      toolDependencies: [
        dep("docs/page.ts", "@/x", null),
        dep("site/page.ts", "~/x", null),
      ],
      context: ctx,
    });
    expect(c.disagreements.map((d) => `${d.from} ${d.verdict}`)).toEqual([
      "docs/page.ts tool-wrong",
      "site/page.ts unclassified",
    ]);
    expect(c.disagreements[0]?.reason).toContain("baseUrl");
  });

  it("names a file loaded at run time by a literal path as outside the tool's scope", () => {
    const c = compareEdges({
      sources: new Set(["a.ts", "b.ts"]),
      epochImports: [
        {
          ...file("a.ts", "./worker.ts", "worker.ts"),
          kind: "dynamic",
          runtimePath: true,
        },
        { ...file("b.ts", "./lazy.ts", "lazy.ts"), kind: "dynamic" },
      ],
      toolDependencies: [],
      context: ctx,
    });
    expect(c.disagreements.map((d) => `${d.from} ${d.verdict}`)).toEqual([
      "a.ts tool-wrong",
      "b.ts unclassified",
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
