import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { Language, Parser } from "web-tree-sitter";
import { EMPTY_EXTRACTOR_CONFIG, type FileFacts } from "@epoch-dev/core";
import { countLoc, extract } from "./extract.js";
import { grammarFor, isTestFile, languageFor } from "./files.js";

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

function facts(file: string, text: string): FileFacts {
  const grammar = grammarFor(file);
  if (!grammar) throw new Error(`no grammar for ${file}`);
  const parser = new Parser();
  parser.setLanguage(languages.get(grammar) ?? null);
  const tree = parser.parse(text);
  if (!tree) throw new Error("parse failed");
  try {
    return extract({ path: file, text, tree }, EMPTY_EXTRACTOR_CONFIG);
  } finally {
    tree.delete();
    parser.delete();
  }
}

describe("extract: imports", () => {
  const src = [
    'import def from "./a";', // 1
    'import { x, y as z, type T } from "./b";', // 2
    'import * as ns from "./c";', // 3
    'import type { U } from "./d";', // 4
    'import "./side-effect";', // 5
    'import def2, { w } from "./e";', // 6
    'const lazy = import("./k");', // 7
    "const tpl = import(`./pages/${name}.js`);", // 8
    "const dyn = import(variable);", // 9
    'const req = require("./l");', // 10
    'import eq = require("./m");', // 11
    'const cat = import("./locales/" + lang);', // 12
    "const plain = import(`./plain.js`);", // 13
    "function f() { return require(`./r/${x}`); }", // 14
  ].join("\n");
  const { imports } = facts("src/app.ts", src);

  it("captures every import form with kind, names and line", () => {
    expect(imports).toEqual([
      {
        kind: "static",
        specifier: "./a",
        typeOnly: false,
        names: [{ imported: "default" }],
        line: 1,
      },
      {
        kind: "static",
        specifier: "./b",
        typeOnly: false,
        names: [{ imported: "x" }, { imported: "y" }],
        line: 2,
      },
      {
        kind: "static",
        specifier: "./b",
        typeOnly: true,
        names: [{ imported: "T" }],
        line: 2,
      },
      {
        kind: "static",
        specifier: "./c",
        typeOnly: false,
        names: [{ imported: "*" }],
        line: 3,
      },
      {
        kind: "static",
        specifier: "./d",
        typeOnly: true,
        names: [{ imported: "U" }],
        line: 4,
      },
      {
        kind: "side-effect",
        specifier: "./side-effect",
        typeOnly: false,
        names: [],
        line: 5,
      },
      {
        kind: "static",
        specifier: "./e",
        typeOnly: false,
        names: [{ imported: "default" }, { imported: "w" }],
        line: 6,
      },
      {
        kind: "dynamic",
        specifier: "./k",
        typeOnly: false,
        names: [],
        line: 7,
      },
      {
        kind: "dynamic",
        specifier: null,
        dynamicPrefix: "./pages/",
        typeOnly: false,
        names: [],
        line: 8,
      },
      { kind: "dynamic", specifier: null, typeOnly: false, names: [], line: 9 },
      {
        kind: "require",
        specifier: "./l",
        typeOnly: false,
        names: [],
        line: 10,
      },
      {
        kind: "require",
        specifier: "./m",
        typeOnly: false,
        names: [],
        line: 11,
      },
      {
        kind: "dynamic",
        specifier: null,
        dynamicPrefix: "./locales/",
        typeOnly: false,
        names: [],
        line: 12,
      },
      {
        kind: "dynamic",
        specifier: "./plain.js",
        typeOnly: false,
        names: [],
        line: 13,
      },
      {
        kind: "require",
        specifier: null,
        dynamicPrefix: "./r/",
        typeOnly: false,
        names: [],
        line: 14,
      },
    ]);
  });
});

describe("extract: exports and re-exports", () => {
  const src = [
    'export { p, q as r } from "./f";', // 1
    'export * from "./g";', // 2
    'export * as h from "./h";', // 3
    'export type { V } from "./i";', // 4
    'export { default as Button } from "./j";', // 5
    "export const local = 1, { a, b: [c] } = obj;", // 6
    "export default function main() {}", // 7
    "export function fn() {}", // 8
    "export class K {}", // 9
    "export interface I {}", // 10
    "export type Alias = string;", // 11
    "export enum E { A }", // 12
    "const hidden = 2;", // 13
    "export { hidden as shown };", // 14
    'export { type W, value } from "./n";', // 15
  ].join("\n");
  const f = facts("src/barrel.ts", src);

  it("lists exported names, with `from` for re-exports", () => {
    expect(f.exports).toEqual([
      { name: "p", from: { specifier: "./f", imported: "p" } },
      { name: "r", from: { specifier: "./f", imported: "q" } },
      { name: "h", from: { specifier: "./h", imported: "*" } },
      { name: "V", from: { specifier: "./i", imported: "V" } },
      { name: "Button", from: { specifier: "./j", imported: "default" } },
      { name: "local" },
      { name: "a" },
      { name: "c" },
      { name: "default" },
      { name: "fn" },
      { name: "K" },
      { name: "I" },
      { name: "Alias" },
      { name: "E" },
      { name: "shown" },
      { name: "W", from: { specifier: "./n", imported: "W" } },
      { name: "value", from: { specifier: "./n", imported: "value" } },
    ]);
    expect(f.exportAllFrom).toEqual(["./g"]);
  });

  it("records each re-export as a reexport import", () => {
    expect(f.imports).toEqual([
      {
        kind: "reexport",
        specifier: "./f",
        typeOnly: false,
        names: [{ imported: "p" }, { imported: "q", exportedAs: "r" }],
        line: 1,
      },
      {
        kind: "reexport",
        specifier: "./g",
        typeOnly: false,
        names: [{ imported: "*" }],
        line: 2,
      },
      {
        kind: "reexport",
        specifier: "./h",
        typeOnly: false,
        names: [{ imported: "*", exportedAs: "h" }],
        line: 3,
      },
      {
        kind: "reexport",
        specifier: "./i",
        typeOnly: true,
        names: [{ imported: "V" }],
        line: 4,
      },
      {
        kind: "reexport",
        specifier: "./j",
        typeOnly: false,
        names: [{ imported: "default", exportedAs: "Button" }],
        line: 5,
      },
      {
        kind: "reexport",
        specifier: "./n",
        typeOnly: false,
        names: [{ imported: "value" }],
        line: 15,
      },
      {
        kind: "reexport",
        specifier: "./n",
        typeOnly: true,
        names: [{ imported: "W" }],
        line: 15,
      },
    ]);
  });

  it("handles `export =` and ignores exports inside ambient module blocks", () => {
    const g = facts(
      "types/legacy.d.ts",
      'declare module "x" {\n  export function inner(): void;\n}\nexport = Legacy;\n',
    );
    expect(g.exports).toEqual([{ name: "export=" }]);
  });
});

describe("extract: file properties", () => {
  it("keeps line numbers right with CRLF line endings", () => {
    const f = facts(
      "a.ts",
      'import a from "./a";\r\n\r\nimport b from "./b";\r\n',
    );
    expect(f.imports.map((i) => i.line)).toEqual([1, 3]);
  });

  it("parses JavaScript and JSX with the JavaScript grammar", () => {
    const f = facts(
      "src/view.jsx",
      'import React from "react";\nconst x = require("./x");\nexport default () => <div />;\n',
    );
    expect(f.imports.map((i) => `${i.kind}:${String(i.specifier)}`)).toEqual([
      "static:react",
      "require:./x",
    ]);
    expect(f.exports).toEqual([{ name: "default" }]);
  });

  it("detects generated-file markers in the header only", () => {
    expect(
      facts("g.ts", "// @generated by protoc\nexport {}\n").isGenerated,
    ).toBe(true);
    expect(
      facts("g.go.ts", "// Code generated by tool. DO NOT EDIT.\n").isGenerated,
    ).toBe(true);
    expect(
      facts("h.ts", "export const s = 'not @generatedx';\n").isGenerated,
    ).toBe(false);
  });

  it("counts non-blank lines as loc", () => {
    expect(countLoc("a\n\n  \nb\r\nc\r")).toBe(3);
    expect(facts("l.ts", "const a = 1;\n\nconst b = 2;\n").loc).toBe(2);
  });
});

describe("file mapping", () => {
  it("maps extensions to grammars and languages", () => {
    expect(
      [
        "a.ts",
        "a.d.ts",
        "a.mts",
        "a.cts",
        "a.tsx",
        "a.js",
        "a.jsx",
        "a.mjs",
        "a.cjs",
        "a.json",
      ].map(grammarFor),
    ).toEqual([
      "typescript",
      "typescript",
      "typescript",
      "typescript",
      "tsx",
      "javascript",
      "javascript",
      "javascript",
      "javascript",
      undefined,
    ]);
    expect(languageFor("x.d.ts")).toBe("typescript");
    expect(languageFor("x.mjs")).toBe("javascript");
  });

  it("recognizes test files", () => {
    expect(isTestFile("src/a.test.ts")).toBe(true);
    expect(isTestFile("src/a.spec.tsx")).toBe(true);
    expect(isTestFile("src/__tests__/helper.ts")).toBe(true);
    expect(isTestFile("src/contest.ts")).toBe(false);
    expect(isTestFile("src/testing/util.ts")).toBe(false);
  });
});
