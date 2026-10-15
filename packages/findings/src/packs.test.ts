import { describe, expect, it } from "vitest";
import { DEFAULT_FLAG_PATTERNS, OPENFEATURE_PATTERNS } from "./packs.js";

describe("OpenFeature pack", () => {
  it("is valid, with unique ids and an official source on every entry", () => {
    const ids = OPENFEATURE_PATTERNS.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const p of OPENFEATURE_PATTERNS) {
      expect(p.provider).toBe("openfeature");
      expect(p.source).toMatch(
        /^https:\/\/github\.com\/open-feature\/(js|python|go)-sdk\/blob\/[0-9a-f]{40}\//,
      );
      expect(p.importHints.length).toBeGreaterThan(0);
    }
    expect(DEFAULT_FLAG_PATTERNS).toBe(OPENFEATURE_PATTERNS);
  });

  it("covers each language's evaluation methods with the right key position", () => {
    const by = (language: string) =>
      OPENFEATURE_PATTERNS.filter((p) => p.language === language);
    expect(by("typescript").map((p) => p.callee)).toContain("getBooleanValue");
    expect(by("typescript").map((p) => p.callee)).toContain(
      "useBooleanFlagValue",
    );
    expect(by("python").map((p) => p.callee)).toContain("get_boolean_value");
    expect(by("go").map((p) => p.callee)).toContain("Boolean");
    expect(new Set(by("go").map((p) => p.keyArgIndex))).toEqual(new Set([1]));
    expect(new Set(by("python").map((p) => p.keyArgIndex))).toEqual(
      new Set([0]),
    );
  });
});
