import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { Language, Parser } from "web-tree-sitter";
import { EMPTY_EXTRACTOR_CONFIG, type FileFacts } from "@epoch-dev/core";
import { extract } from "./extract.js";
import { grammarFor, isTestFile, languageFor } from "./files.js";

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

function facts(file: string, text: string): FileFacts {
  const parser = new Parser();
  parser.setLanguage(python);
  const tree = parser.parse(text);
  if (!tree) throw new Error("parse failed");
  try {
    return extract({ path: file, text, tree }, EMPTY_EXTRACTOR_CONFIG);
  } finally {
    tree.delete();
    parser.delete();
  }
}

const lines = (...ls: string[]) => `${ls.join("\n")}\n`;

describe("extract: imports", () => {
  it("records every import form with its names and line", () => {
    const f = facts(
      "app.py",
      lines(
        "import a.b.c",
        "import a.b as c, d",
        "from x.y import n, m as k",
        "from . import sib",
        "from ..pkg.mod import (q,",
        "    r)",
        "from .mod import *",
        "from __future__ import annotations, division",
      ),
    );
    expect(
      f.imports.map((i) => [
        i.kind,
        i.specifier,
        i.names.map((n) => n.imported),
        i.line,
      ]),
    ).toEqual([
      ["static", "a.b.c", ["*"], 1],
      ["static", "a.b", ["*"], 2],
      ["static", "d", ["*"], 2],
      ["static", "x.y", ["n"], 3],
      ["static", "x.y", ["m"], 3],
      ["static", ".", ["sib"], 4],
      ["static", "..pkg.mod", ["q"], 5],
      ["static", "..pkg.mod", ["r"], 5],
      ["static", ".mod", ["*"], 7],
      ["static", "__future__", ["annotations", "division"], 8],
    ]);
    expect(f.imports.every((i) => !i.typeOnly)).toBe(true);
  });

  it("marks imports under `if TYPE_CHECKING:` as type-only, but not its else branch", () => {
    const f = facts(
      "app.py",
      lines(
        "import typing",
        "if typing.TYPE_CHECKING:",
        "    from a import A",
        "else:",
        "    from b import B",
        "if TYPE_CHECKING:",
        "    if True:",
        "        import c",
        "if not TYPE_CHECKING:",
        "    import d",
      ),
    );
    expect(f.imports.map((i) => [i.specifier, i.typeOnly])).toEqual([
      ["typing", false],
      ["a", true],
      ["b", false],
      ["c", true],
      ["d", false],
    ]);
  });

  it("records both imports of a try/except fallback and lazy imports in functions", () => {
    const f = facts(
      "app.py",
      lines(
        "try:",
        "    import ujson as json",
        "except ImportError:",
        "    import json",
        "def f():",
        "    import lazy",
      ),
    );
    expect(f.imports.map((i) => i.specifier)).toEqual([
      "ujson",
      "json",
      "lazy",
    ]);
  });

  it("turns importlib and __import__ calls into dynamic imports", () => {
    const f = facts(
      "app.py",
      lines(
        'importlib.import_module("plug.a")',
        'import_module("plug.b")',
        '__import__("plug.c")',
        'builtins.__import__("plug.d")',
        'importlib.import_module(name="plug.e")',
        'importlib.import_module("plug." "f")',
        "importlib.import_module(name)",
        'importlib.import_module(f"plugins.{name}")',
        'importlib.import_module("plugins." + name)',
        'importlib.import_module(b"bytes")',
        'other.import_module("not.this")',
        'loader.load("not.this.either")',
      ),
    );
    expect(
      f.imports.map((i) => [
        i.kind,
        i.specifier,
        i.dynamicPrefix ?? null,
        i.line,
      ]),
    ).toEqual([
      ["dynamic", "plug.a", null, 1],
      ["dynamic", "plug.b", null, 2],
      ["dynamic", "plug.c", null, 3],
      ["dynamic", "plug.d", null, 4],
      ["dynamic", "plug.e", null, 5],
      ["dynamic", "plug.f", null, 6],
      ["dynamic", null, null, 7],
      ["dynamic", null, "plugins.", 8],
      ["dynamic", null, "plugins.", 9],
      ["dynamic", null, null, 10],
    ]);
  });
});

describe("extract: re-exports and exports", () => {
  it("treats module-level from-imports in __init__.py as re-exports", () => {
    const f = facts(
      "pkg/__init__.py",
      lines(
        "from .core import Engine, run as start",
        "from .extras import *",
        "import os",
        "def helper():",
        "    from .lazy import Lazy",
      ),
    );
    expect(f.imports.map((i) => [i.kind, i.specifier])).toEqual([
      ["reexport", ".core"],
      ["reexport", ".core"],
      ["reexport", ".extras"],
      ["static", "os"],
      ["static", ".lazy"],
    ]);
    expect(f.exportAllFrom).toEqual([".extras"]);
    expect(f.exports).toEqual([
      { name: "Engine", from: { specifier: ".core", imported: "Engine" } },
      { name: "helper" },
      { name: "start", from: { specifier: ".core", imported: "run" } },
    ]);
  });

  it("does not treat from-imports in an ordinary module as re-exports", () => {
    const f = facts("pkg/mod.py", "from .core import Engine\n");
    expect(f.imports[0]?.kind).toBe("static");
    expect(f.exports).toEqual([]);
  });

  it("exports public module-level definitions and assignments", () => {
    const f = facts(
      "mod.py",
      lines(
        "import os",
        "X = 1",
        "a, (b, c) = 1, (2, 3)",
        "_private = 2",
        "y: int = 3",
        "@decorator",
        "def f(): pass",
        "class C:",
        "    inner = 1",
        "if os.name == 'nt':",
        "    def g(): pass",
        "def outer():",
        "    hidden = 1",
      ),
    );
    expect(f.exports.map((e) => e.name)).toEqual([
      "C",
      "X",
      "a",
      "b",
      "c",
      "f",
      "g",
      "outer",
      "y",
    ]);
  });

  it("follows a literal __all__, private names included", () => {
    const f = facts(
      "pkg/__init__.py",
      lines(
        "from .core import Engine, Other",
        "_internal = 1",
        "public = 2",
        '__all__ = ["Engine", "_internal"]',
      ),
    );
    expect(f.exports.map((e) => e.name)).toEqual(["Engine", "_internal"]);
  });
});

describe("extract: file facts", () => {
  it("counts non-blank lines and spots generated files", () => {
    expect(facts("a.py", "x = 1\n\n  \ny = 2\n").loc).toBe(2);
    expect(facts("a.py", "# @generated by tool\nx = 1\n").isGenerated).toBe(
      true,
    );
    expect(facts("a.py", "x = 1\n").isGenerated).toBe(false);
  });
});

describe("extract: key-like strings", () => {
  it("keeps plain key-like literals, not f-strings, prose or dynamic import names", () => {
    const f = facts(
      "app/jobs.py",
      lines(
        "import importlib",
        'EVENT = "user.created"',
        "def run(y):",
        '    publish("orders-topic", f"x.{y}")',
        '    os.environ.get("APP_SETTINGS_THEME")',
        '    importlib.import_module("plugins.audit")',
        '    print("Hello world")',
      ),
    );
    expect(f.strings).toEqual([
      "APP_SETTINGS_THEME",
      "orders-topic",
      "user.created",
    ]);
  });
});

describe("files", () => {
  it("maps .py and .pyi to the Python grammar", () => {
    expect(grammarFor("a/b.py")).toBe("python");
    expect(grammarFor("a/b.pyi")).toBe("python");
    expect(grammarFor("a/b.pyc")).toBeUndefined();
    expect(languageFor("a/b.py")).toBe("python");
  });

  it.each([
    ["test_app.py", true],
    ["pkg/app_test.py", true],
    ["conftest.py", true],
    ["tests/helpers.py", true],
    ["pkg/test/util.py", true],
    ["pkg/contest.py", false],
    ["pkg/testing.py", false],
    ["latest/app.py", false],
  ])("isTestFile(%s) is %s", (p, expected) => {
    expect(isTestFile(p)).toBe(expected);
  });
});
