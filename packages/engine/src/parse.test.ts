import { afterAll, describe, expect, it } from "vitest";
import { assertAbiSupported, GRAMMARS, Parsers } from "./parse.js";

describe("Parsers", async () => {
  const parsers = await Parsers.load(Object.keys(GRAMMARS));
  afterAll(() => {
    parsers.dispose();
  });

  it("loads and self-tests every grammar", () => {
    for (const name of ["typescript", "tsx", "javascript", "python", "go"]) {
      expect(parsers.language(name).abiVersion).toBeGreaterThan(0);
    }
  });

  it("parses TSX and JSX", () => {
    for (const name of ["tsx", "javascript"]) {
      const tree = parsers.parse(name, "export const A = () => <b>{x}</b>;\n");
      expect(tree.rootNode.hasError).toBe(false);
      tree.delete();
    }
  });

  it("keeps line numbers right for CRLF sources", () => {
    const tree = parsers.parse(
      "typescript",
      'import a from "./a";\r\n\r\nimport b from "./b";\r\n',
    );
    const rows = tree.rootNode.namedChildren.map((n) => n.startPosition.row);
    expect(rows).toEqual([0, 2]);
    tree.delete();
  });

  it("rejects unknown grammars and grammars it did not load", async () => {
    await expect(Parsers.load(["cobol"])).rejects.toThrow(/Unknown grammar/);
    const tsOnly = await Parsers.load(["typescript"]);
    try {
      expect(() => tsOnly.language("python")).toThrow(/not loaded/);
    } finally {
      tsOnly.dispose();
    }
  });
});

describe("assertAbiSupported", () => {
  it("accepts ABIs inside the runtime range and rejects others", () => {
    expect(() => {
      assertAbiSupported("x", 14, 13, 15);
    }).not.toThrow();
    expect(() => {
      assertAbiSupported("x", 12, 13, 15);
    }).toThrow(/ABI 12/);
    expect(() => {
      assertAbiSupported("x", 16, 13, 15);
    }).toThrow(/ADR-002/);
  });
});
