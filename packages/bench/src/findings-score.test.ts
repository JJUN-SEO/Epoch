import { describe, expect, it } from "vitest";
import { parseCsv, score } from "./findings-score.js";

describe("findings review scoring", () => {
  it("parses quoted cells, doubled quotes and newlines inside quotes", () => {
    expect(parseCsv('a,b\n"x, y","say ""hi""\nthere"\n')).toEqual([
      ["a", "b"],
      ["x, y", 'say "hi"\nthere'],
    ]);
  });

  it("counts verdicts per confidence level, leaving unsure and blank out of precision", () => {
    const csv = [
      "n,confidence,verdict",
      "1,high,yes",
      "2,high,YES",
      "3,high,no",
      "4,medium,unsure",
      "5,medium,",
    ].join("\n");
    expect(score(parseCsv(csv))).toEqual([
      { level: "high", yes: 2, no: 1, unsure: 0, blank: 0 },
      { level: "medium", yes: 0, no: 0, unsure: 1, blank: 1 },
    ]);
  });
});
