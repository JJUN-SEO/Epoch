import { describe, expect, it } from "vitest";
import { normalizeLine, sourceLines } from "./source-lines.js";

describe("sourceLines", () => {
  it("keeps whitespace-normalized lines of 10 or more characters", () => {
    const text = [
      "import { a } from './a';",
      "",
      "  }",
      "return x;",
      "\texport   const   value = 1;  ",
      "short",
    ].join("\r\n");
    expect([...sourceLines(text)]).toEqual([
      "import { a } from './a';",
      "export const value = 1;",
    ]);
    expect(normalizeLine("  a\t\tb \n c ")).toBe("a b c");
  });
});
