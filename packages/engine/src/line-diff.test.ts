import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { splitLines, unchangedLines } from "./line-diff.js";

const map = (a: string, b: string) => {
  const m = unchangedLines(a.split(""), b.split(""));
  return m === undefined ? undefined : [...m];
};

describe("unchangedLines", () => {
  it("maps unchanged lines to their HEAD position and marks the rest -1", () => {
    expect(map("abc", "abc")).toEqual([0, 1, 2]);
    expect(map("abc", "aXbc")).toEqual([0, -1, 1, 2]);
    expect(map("abc", "ac")).toEqual([0, 2]);
    expect(map("abcd", "abXd")).toEqual([0, 1, -1, 3]);
    expect(map("", "ab")).toEqual([-1, -1]);
    expect(map("ab", "")).toEqual([]);
    expect(map("xabcy", "zabcw")).toEqual([-1, 1, 2, 3, -1]);
  });

  it("keeps a longest common subsequence, in order, of equal lines", () => {
    fc.assert(
      fc.property(
        fc.array(fc.constantFrom("a", "b", "c"), { maxLength: 30 }),
        fc.array(fc.constantFrom("a", "b", "c"), { maxLength: 30 }),
        (before, after) => {
          const m = unchangedLines(before, after);
          if (m === undefined) return false;
          let last = -1;
          let kept = 0;
          for (const [i, j] of m.entries()) {
            if (j === -1) continue;
            if (j <= last || before[j] !== after[i]) return false;
            last = j;
            kept++;
          }
          // LCS length by dynamic programming, in one flat table.
          const w = after.length + 1;
          const dp = new Int32Array((before.length + 1) * w);
          const at = (i: number, j: number) => dp[i * w + j] ?? 0;
          for (let i = 1; i <= before.length; i++) {
            for (let j = 1; j <= after.length; j++) {
              dp[i * w + j] =
                before[i - 1] === after[j - 1]
                  ? at(i - 1, j - 1) + 1
                  : Math.max(at(i - 1, j), at(i, j - 1));
            }
          }
          return kept === at(before.length, after.length);
        },
      ),
    );
  });

  it("gives up past the edit cap", () => {
    const before = Array.from({ length: 3000 }, (_, i) => `a${String(i)}`);
    const after = Array.from({ length: 3000 }, (_, i) => `b${String(i)}`);
    expect(unchangedLines(before, after)).toBeUndefined();
  });
});

describe("splitLines", () => {
  it("splits CRLF and LF and drops the final empty line", () => {
    expect(splitLines("a\r\nb\nc\n")).toEqual(["a", "b", "c"]);
    expect(splitLines("a")).toEqual(["a"]);
    expect(splitLines("")).toEqual([]);
  });
});
