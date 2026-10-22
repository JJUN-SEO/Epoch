import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { Language, Parser } from "web-tree-sitter";
import type { ExtractorConfig, FileFacts } from "@epoch-dev/core";
import { extract } from "./extract.js";

await Parser.init();
const python = await Language.load(
  fs.readFileSync(
    path.join(
      path.dirname(
        createRequire(import.meta.url).resolve(
          "@vscode/tree-sitter-wasm/package.json",
        ),
      ),
      "wasm",
      "tree-sitter-python.wasm",
    ),
  ),
);

const CFG: ExtractorConfig = {
  flagPatterns: [
    {
      id: "openfeature.python.get-boolean-value",
      provider: "openfeature",
      language: "python",
      callee: "get_boolean_value",
      keyArgIndex: 0,
      importHints: ["openfeature"],
      source: "https://example.test/docs",
    },
  ],
  wrapperFunctions: ["feature_enabled"],
  envPrefixes: ["FEATURE_"],
};

function facts(text: string, file = "app/a.py"): FileFacts {
  const parser = new Parser();
  parser.setLanguage(python);
  const tree = parser.parse(text);
  if (!tree) throw new Error("parse failed");
  try {
    return extract({ path: file, text, tree }, CFG);
  } finally {
    tree.delete();
    parser.delete();
  }
}

const lines = (...ls: string[]) => `${ls.join("\n")}\n`;

describe("findings facts: flag usages", () => {
  it("matches SDK calls, strong only when the file imports a hinted module", () => {
    const strong = facts(
      lines(
        "from openfeature import api",
        "client = api.get_client()",
        'client.get_boolean_value("new-checkout", False)',
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
        patternId: "openfeature.python.get-boolean-value",
      },
    ]);
    const weak = facts('client.get_boolean_value("x", False)\n');
    expect(weak.flagUsages.map((u) => u.strength)).toEqual(["weak"]);
  });

  it("records f-strings and names as unassessable keys", () => {
    const f = facts(
      lines(
        'client.get_boolean_value(f"a{b}", False)',
        "client.get_boolean_value(key, False)",
        'client.get_boolean_value(flag_key="x", default_value=False)',
      ),
    );
    expect(f.flagUsages.map((u) => u.flagName)).toEqual([null, null, null]);
  });

  it("matches wrappers and the standard env reads with a configured prefix", () => {
    const f = facts(
      lines(
        "import os",
        'if feature_enabled("beta"): pass',
        'a = os.getenv("FEATURE_A")',
        'b = os.environ.get("FEATURE_B", "0")',
        'c = os.environ["FEATURE_C"]',
        'd = os.getenv("OTHER")',
      ),
    );
    expect(
      f.flagUsages.map((u) => [u.flagName, u.detection, u.strength, u.line]),
    ).toEqual([
      ["beta", "wrapper-call", "strong", 2],
      ["FEATURE_A", "env-read", "strong", 3],
      ["FEATURE_B", "env-read", "strong", 4],
      ["FEATURE_C", "env-read", "strong", 5],
    ]);
  });
});

describe("findings facts: constant conditions", () => {
  it("finds literal conditions, elif chains and conditional expressions", () => {
    const f = facts(
      lines(
        "if False:", // 1
        "    a()",
        "if True:", // 3
        "    b()",
        "elif x:",
        "    c()",
        "else:",
        "    d()",
        "if x:", // 9
        "    e()",
        "elif True:", // 11
        "    f()",
        "else:",
        "    g()", // 14
        "v = 1 if not True else 2", // 15
      ),
    );
    expect(f.constantConditions).toEqual([
      {
        name: null,
        value: false,
        scope: "literal",
        line: 1,
        endLine: 2,
        deadBranch: "then",
      },
      {
        name: null,
        value: true,
        scope: "literal",
        line: 3,
        endLine: 8,
        deadBranch: "else",
      },
      {
        name: null,
        value: true,
        scope: "literal",
        line: 11,
        endLine: 14,
        deadBranch: "else",
      },
      {
        name: null,
        value: false,
        scope: "literal",
        line: 15,
        endLine: 15,
        deadBranch: "then",
      },
    ]);
  });

  it("scopes names as local, module (leading underscore) or exported", () => {
    const f = facts(
      lines(
        "_PRIVATE = False",
        "PUBLIC = False",
        "def g():",
        "    loc = False",
        "    if loc:",
        "        a()",
        "if _PRIVATE:",
        "    b()",
        "if PUBLIC:",
        "    c()",
      ),
    );
    expect(f.constantConditions.map((c) => [c.name, c.scope, c.line])).toEqual([
      ["loc", "local", 5],
      ["_PRIVATE", "module", 7],
      ["PUBLIC", "exported", 9],
    ]);
  });

  it("skips reassigned, global-rebound, class, typing and env-derived names", () => {
    const f = facts(
      lines(
        "import os",
        "from typing import TYPE_CHECKING",
        "A = False",
        "A = True",
        "B = False",
        "def flip():",
        "    global B",
        "    B = True",
        "class K:",
        "    C = False",
        "    if C:",
        "        pass",
        "D = os.getenv('D') == '1'",
        "if A:",
        "    a()",
        "if B:",
        "    b()",
        "if TYPE_CHECKING:",
        "    import x",
        "if D:",
        "    d()",
      ),
    );
    expect(f.constantConditions).toEqual([]);
  });
});
