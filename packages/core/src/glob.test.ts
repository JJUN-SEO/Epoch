import { describe, expect, it } from "vitest";
import { globMatcher, matchesGlob } from "./glob.js";

describe("matchesGlob", () => {
  it.each([
    ["src/main.ts", "src/main.ts", true],
    ["src/main.ts", "src/main.tsx", false],
    ["src/*.ts", "src/a.ts", true],
    ["src/*.ts", "src/a/b.ts", false],
    ["scripts/**", "scripts/a.js", true],
    ["scripts/**", "scripts/a/b/c.js", true],
    ["scripts/**", "scripts", false],
    ["**/generated/**", "generated/x.ts", true],
    ["**/generated/**", "a/b/generated/c/x.ts", true],
    ["**/generated/**", "a/generatedx/x.ts", false],
    ["**/*.test.ts", "a.test.ts", true],
    ["**/*.test.ts", "x/y/a.test.ts", true],
    ["legacy/", "legacy/old.py", true],
    ["src/?.ts", "src/a.ts", true],
    ["src/?.ts", "src/ab.ts", false],
    ["src/{a,b}.ts", "src/b.ts", true],
    ["src/{a,b}.ts", "src/c.ts", false],
    ["{src,lib}/**/*.{ts,js}", "lib/x/y.js", true],
    ["a/**/b", "a/b", true],
    ["a/**/b", "a/x/y/b", true],
    ["*", "a.ts", true],
    ["*", "dir/a.ts", false],
    ["[ab].ts", "[ab].ts", true],
    ["[ab].ts", "a.ts", false],
  ])("%s ~ %s → %s", (pattern, path, expected) => {
    expect(matchesGlob(pattern, path)).toBe(expected);
  });

  it("stays fast on patterns that make backtracking matchers explode", () => {
    const pattern = `${"*a".repeat(40)}*b`;
    const path = "a".repeat(200);
    const started = performance.now();
    expect(matchesGlob(pattern, path)).toBe(false);
    expect(matchesGlob("**/".repeat(30) + "x", `${"d/".repeat(60)}y`)).toBe(
      false,
    );
    expect(performance.now() - started).toBeLessThan(500);
  });

  it("refuses oversized patterns and brace explosions instead of matching them", () => {
    expect(() => globMatcher(["a".repeat(2000)])).toThrow(/too long/);
    expect(() => globMatcher(["{a,b}".repeat(12)])).toThrow(/alternatives/);
  });

  it("matches any of several patterns", () => {
    const m = globMatcher(["src/main.ts", "scripts/**"]);
    expect(m("scripts/x.js")).toBe(true);
    expect(m("src/other.ts")).toBe(false);
    expect(globMatcher([])("anything")).toBe(false);
  });
});
