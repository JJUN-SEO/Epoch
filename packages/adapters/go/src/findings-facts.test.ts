import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { Language, Parser } from "web-tree-sitter";
import type { ExtractorConfig, FileFacts } from "@epoch-dev/core";
import { extract } from "./extract.js";

await Parser.init();
const go = await Language.load(
  fs.readFileSync(
    path.join(
      path.dirname(
        createRequire(import.meta.url).resolve(
          "@vscode/tree-sitter-wasm/package.json",
        ),
      ),
      "wasm",
      "tree-sitter-go.wasm",
    ),
  ),
);

const HINT = "github.com/open-feature/go-sdk/openfeature";
const CFG: ExtractorConfig = {
  flagPatterns: [
    {
      id: "openfeature.go.boolean-value",
      provider: "openfeature",
      language: "go",
      callee: "BooleanValue",
      keyArgIndex: 1,
      importHints: [HINT],
      source: "https://example.test/docs",
    },
  ],
  wrapperFunctions: ["FeatureEnabled"],
  envPrefixes: ["FEATURE_"],
};

function facts(text: string): FileFacts {
  const parser = new Parser();
  parser.setLanguage(go);
  const tree = parser.parse(text);
  if (!tree) throw new Error("parse failed");
  try {
    return extract({ path: "a/a.go", text, tree }, CFG);
  } finally {
    tree.delete();
    parser.delete();
  }
}

const lines = (...ls: string[]) => `${ls.join("\n")}\n`;

describe("findings facts: flag usages", () => {
  it("reads the key from the second argument, strong only with the SDK import", () => {
    const strong = facts(
      lines(
        "package a",
        `import "${HINT}"`,
        "func f() {",
        '\tv, _ := client.BooleanValue(ctx, "new-checkout", false, openfeature.EvaluationContext{})',
        "\t_ = v",
        "}",
      ),
    );
    expect(strong.flagUsages).toEqual([
      {
        flagName: "new-checkout",
        line: 4,
        endLine: 4,
        detection: "sdk-call",
        strength: "strong",
        provider: "openfeature",
        patternId: "openfeature.go.boolean-value",
      },
    ]);
    const weak = facts(
      lines(
        "package a",
        "func f() {",
        '\tclient.BooleanValue(ctx, "x", false, nil)',
        "}",
      ),
    );
    expect(weak.flagUsages.map((u) => u.strength)).toEqual(["weak"]);
  });

  it("records a non-literal key as null and decodes raw strings", () => {
    const f = facts(
      lines(
        "package a",
        "func f() {",
        "\tclient.BooleanValue(ctx, key, false, nil)",
        "\tclient.BooleanValue(ctx, `raw-key`, false, nil)",
        "}",
      ),
    );
    expect(f.flagUsages.map((u) => u.flagName)).toEqual([null, "raw-key"]);
  });

  it("matches wrappers and os.Getenv / os.LookupEnv with a configured prefix", () => {
    const f = facts(
      lines(
        "package a",
        'import "os"',
        "func f() {",
        '\tif FeatureEnabled("beta") {}',
        '\t_ = os.Getenv("FEATURE_A")',
        '\t_, _ = os.LookupEnv("FEATURE_B")',
        '\t_ = os.Getenv("OTHER")',
        "}",
      ),
    );
    expect(
      f.flagUsages.map((u) => [u.flagName, u.detection, u.strength, u.line]),
    ).toEqual([
      ["beta", "wrapper-call", "strong", 4],
      ["FEATURE_A", "env-read", "strong", 5],
      ["FEATURE_B", "env-read", "strong", 6],
    ]);
  });
});

describe("findings facts: what is not a flag", () => {
  it("skips package functions, unqualified calls and empty keys", () => {
    const f = facts(
      lines(
        "package a",
        'import "flag"',
        'import pf "github.com/spf13/pflag"',
        'import yaml "gopkg.in/yaml.v3"',
        "func f() {",
        '\tflag.String("listen", "0.0.0.0:80", "address")',
        '\tpf.Boolean(ctx, "x", false, nil)',
        '\tBooleanValue(ctx, "y", false, nil)',
        '\tcmd.Flags().String("json", "", "fields")',
        '\tclient.BooleanValue(ctx, "real", false, nil)',
        "}",
      ),
    );
    expect(f.flagUsages.map((u) => [u.flagName, u.line])).toEqual([
      ["real", 10],
    ]);
  });
});

describe("findings facts: constant conditions", () => {
  it("finds literal and constant conditions with their scope and dead branch", () => {
    const f = facts(
      lines(
        "package a", // 1
        "const enabled = false",
        "const Public = false",
        "func f() {", // 4
        "\tconst local = true",
        "\tif local {",
        "\t\ta()",
        "\t} else {",
        "\t\tb()",
        "\t}", // 10
        "\tif enabled {",
        "\t\tc()",
        "\t}",
        "\tif !Public {} else {",
        "\t\td()",
        "\t}",
        "\tif false {",
        "\t\te()",
        "\t}",
        "}",
      ),
    );
    expect(f.constantConditions).toEqual([
      {
        name: "local",
        value: true,
        scope: "local",
        line: 6,
        endLine: 10,
        deadBranch: "else",
      },
      {
        name: "enabled",
        value: false,
        scope: "module",
        line: 11,
        endLine: 13,
        deadBranch: "then",
      },
      {
        name: "Public",
        value: true,
        scope: "exported",
        line: 14,
        endLine: 16,
        deadBranch: "else",
      },
      {
        name: null,
        value: false,
        scope: "literal",
        line: 17,
        endLine: 19,
        deadBranch: "then",
      },
    ]);
  });

  it("skips vars, shadowed names and iota repetition", () => {
    const f = facts(
      lines(
        "package a",
        "var v = false",
        "const c = false",
        "const (",
        "\tx = iota",
        "\ty",
        ")",
        "func f(c bool) {",
        "\tif v {",
        "\t}",
        "\tif c {",
        "\t}",
        "}",
      ),
    );
    expect(f.constantConditions).toEqual([]);
  });
});
