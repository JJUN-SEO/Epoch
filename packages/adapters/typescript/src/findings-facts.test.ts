import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { Language, Parser } from "web-tree-sitter";
import {
  EMPTY_EXTRACTOR_CONFIG,
  type ExtractorConfig,
  type FileFacts,
} from "@epoch-dev/core";
import { extract } from "./extract.js";
import { grammarFor } from "./files.js";

await Parser.init();
const wasmDir = path.join(
  path.dirname(
    createRequire(import.meta.url).resolve(
      "@vscode/tree-sitter-wasm/package.json",
    ),
  ),
  "wasm",
);
const languages = new Map<string, Language>();
for (const g of ["typescript", "tsx", "javascript"]) {
  languages.set(
    g,
    await Language.load(
      fs.readFileSync(path.join(wasmDir, `tree-sitter-${g}.wasm`)),
    ),
  );
}

const CFG: ExtractorConfig = {
  flagPatterns: [
    {
      id: "openfeature.js.get-boolean-value",
      provider: "openfeature",
      language: "typescript",
      callee: "getBooleanValue",
      keyArgIndex: 0,
      importHints: ["@openfeature/server-sdk"],
      source: "https://example.test/docs",
    },
  ],
  wrapperFunctions: ["featureEnabled"],
  envPrefixes: ["FEATURE_"],
};

function facts(text: string, cfg = CFG, file = "src/a.ts"): FileFacts {
  const grammar = grammarFor(file);
  if (!grammar) throw new Error(`no grammar for ${file}`);
  const parser = new Parser();
  parser.setLanguage(languages.get(grammar) ?? null);
  const tree = parser.parse(text);
  if (!tree) throw new Error("parse failed");
  try {
    return extract({ path: file, text, tree }, cfg);
  } finally {
    tree.delete();
    parser.delete();
  }
}

const lines = (...ls: string[]) => `${ls.join("\n")}\n`;

describe("findings facts: flag usages", () => {
  it("matches SDK calls, strong only when the file imports a hinted package", () => {
    const strong = facts(
      lines(
        'import { OpenFeature } from "@openfeature/server-sdk";',
        "const client = OpenFeature.getClient();",
        'await client.getBooleanValue("new-checkout", false);',
      ),
    );
    expect(strong.flagUsages).toEqual([
      {
        flagName: "new-checkout",
        line: 3,
        endLine: 3,
        detection: "sdk-call",
        strength: "strong",
        provider: "openfeature",
        patternId: "openfeature.js.get-boolean-value",
      },
    ]);
    const weak = facts('client.getBooleanValue("new-checkout", false);\n');
    expect(weak.flagUsages.map((u) => u.strength)).toEqual(["weak"]);
  });

  it("records a non-literal key as null", () => {
    const f = facts(
      lines(
        "client.getBooleanValue(key, false);",
        "client.getBooleanValue(`a${b}`, false);",
      ),
    );
    expect(f.flagUsages.map((u) => u.flagName)).toEqual([null, null]);
  });

  it("accepts a template literal without substitutions as a key", () => {
    const f = facts("client.getBooleanValue(`plain`, false);\n");
    expect(f.flagUsages.map((u) => u.flagName)).toEqual(["plain"]);
  });

  it("matches wrapper functions and prefixed env reads as strong", () => {
    const f = facts(
      lines(
        'if (featureEnabled("beta")) run();',
        "const a = process.env.FEATURE_X;",
        'const b = process.env["FEATURE_Y"];',
        "const c = import.meta.env.FEATURE_Z;",
        "const d = process.env.OTHER;",
      ),
    );
    expect(
      f.flagUsages.map((u) => [u.flagName, u.detection, u.strength, u.line]),
    ).toEqual([
      ["beta", "wrapper-call", "strong", 1],
      ["FEATURE_X", "env-read", "strong", 2],
      ["FEATURE_Y", "env-read", "strong", 3],
      ["FEATURE_Z", "env-read", "strong", 4],
    ]);
  });

  it("finds nothing with an empty extractor config", () => {
    const f = facts(
      'featureEnabled("beta"); process.env.FEATURE_X; c.getBooleanValue("x");\n',
      EMPTY_EXTRACTOR_CONFIG,
    );
    expect(f.flagUsages).toEqual([]);
  });
});

describe("findings facts: constant conditions", () => {
  it("finds literal conditions and their dead branch", () => {
    const f = facts(
      lines(
        "if (false) {", // 1
        "  a();",
        "}",
        "if (!false) {", // 4
        "  b();",
        "} else {",
        "  c();",
        "}",
        "const v = true ? 1 : 2;", // 9
      ),
    );
    expect(f.constantConditions).toEqual([
      {
        name: null,
        value: false,
        scope: "literal",
        line: 1,
        endLine: 3,
        deadBranch: "then",
      },
      {
        name: null,
        value: true,
        scope: "literal",
        line: 4,
        endLine: 8,
        deadBranch: "else",
      },
      {
        name: null,
        value: true,
        scope: "literal",
        line: 9,
        endLine: 9,
        deadBranch: "else",
      },
    ]);
  });

  it("does not report a true condition without an else", () => {
    expect(facts("if (true) { a(); }\n").constantConditions).toEqual([]);
  });

  it("scopes named constants as local, module or exported", () => {
    const f = facts(
      lines(
        "const MOD = false;",
        "export const EXP = false;",
        "const VIA = false;",
        "export { VIA };",
        "function g() {",
        "  const LOC = false;",
        "  if (LOC) a();",
        "}",
        "if (MOD) b();",
        "if (EXP) c();",
        "if (VIA) d();",
      ),
    );
    expect(f.constantConditions.map((c) => [c.name, c.scope, c.line])).toEqual([
      ["LOC", "local", 7],
      ["MOD", "module", 9],
      ["EXP", "exported", 10],
      ["VIA", "exported", 11],
    ]);
  });

  it("skips reassigned, shadowed, var and non-literal names", () => {
    const f = facts(
      lines(
        "let A = false;",
        "A = true;",
        "let B = false;",
        "B++;",
        "const C = false;",
        "function h(C: boolean) { if (C) x(); }",
        "var D = false;",
        "const E = process.env.X === '1';",
        "if (A) a();",
        "if (B) b();",
        "if (C) c();",
        "if (D) d();",
        "if (E) e();",
      ),
    );
    expect(f.constantConditions).toEqual([]);
  });

  it("accepts a let that is never written", () => {
    const f = facts(lines("let ON = false;", "if (ON) a();"));
    expect(f.constantConditions.map((c) => [c.name, c.scope])).toEqual([
      ["ON", "module"],
    ]);
  });
});
