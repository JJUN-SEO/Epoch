import { describe, expect, it } from "vitest";
import { fuzzyFilter, fuzzyScore } from "./fuzzy";

describe("fuzzyScore", () => {
  it("matches characters in order, ignoring case and spaces", () => {
    expect(fuzzyScore("A.TS", "src/a.ts")).toBeDefined();
    expect(fuzzyScore("s a", "src/a.ts")).toBeDefined();
    expect(fuzzyScore("sta", "src/a.ts")).toBeUndefined();
    expect(fuzzyScore("", "anything")).toBe(0);
  });

  it("prefers matches in the file name over matches in folders", () => {
    const [first] = fuzzyFilter(
      ["build/utils/x.ts", "src/ui.ts"],
      "ui",
      (s) => s,
      10,
    );
    expect(first).toBe("src/ui.ts");
  });

  it("prefers word starts and consecutive runs", () => {
    expect(
      fuzzyFilter(["src/database.ts", "src/a.ts"], "ats", (s) => s, 10),
    ).toEqual(["src/a.ts", "src/database.ts"]);
    expect(
      fuzzyFilter(["src/getGraph.ts", "src/geography.ts"], "gg", (s) => s, 10),
    ).toEqual(["src/getGraph.ts", "src/geography.ts"]);
  });
});

describe("fuzzyFilter", () => {
  it("drops non-matches, breaks ties by key, and limits", () => {
    expect(
      fuzzyFilter(["b/x.ts", "a/x.ts", "c/y.ts"], "x", (s) => s, 10),
    ).toEqual(["a/x.ts", "b/x.ts"]);
    expect(fuzzyFilter(["a", "b", "c"], "", (s) => s, 2)).toEqual(["a", "b"]);
  });
});
