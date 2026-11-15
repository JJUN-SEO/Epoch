import { describe, expect, it } from "vitest";
import type { Graph } from "@epoch-dev/core";
import { connect, connectionSentence } from "./connect";
import { graph } from "./test-graph";

const edge = (
  source: string,
  target: string,
  confidence = 1,
): Graph["edges"][number] => ({
  source,
  target,
  kind: confidence < 1 ? "cochange" : "import",
  provenance: confidence < 1 ? "git-cochange" : "resolver",
  confidence,
  evidence: [],
});

const g: Graph = {
  ...graph(["a.ts", "b.ts", "c.ts", "d.ts", "e.ts"]),
  edges: [
    edge("a.ts", "b.ts"),
    edge("b.ts", "c.ts"),
    edge("a.ts", "d.ts", 0.7),
    edge("d.ts", "e.ts", 0.9),
  ],
};

describe("connect", () => {
  it("finds how the selected file depends on another", () => {
    const c = connect(g, "a.ts", "c.ts", 0.5);
    expect(c).toMatchObject({
      kind: "forward",
      path: { nodes: ["a.ts", "b.ts", "c.ts"], viaHints: 0 },
    });
    expect(connectionSentence(c)).toBe(
      "This file depends on it through 2 imports.",
    );
  });

  it("looks the other way round when it does not", () => {
    const c = connect(g, "c.ts", "a.ts", 0.5);
    expect(c).toMatchObject({
      kind: "reverse",
      path: { nodes: ["a.ts", "b.ts", "c.ts"] },
    });
    expect(connectionSentence(c)).toBe(
      "This file does not depend on it. It depends on this file through 2 imports.",
    );
  });

  it("uses likely relations only when no proven chain exists, and says so", () => {
    const one = connect(g, "a.ts", "d.ts", 0.5);
    expect(connectionSentence(one)).toBe(
      "This file depends on it through 1 import. It is a likely relation, not a proven import.",
    );
    expect(connectionSentence(connect(g, "a.ts", "e.ts", 0.5))).toBe(
      "This file depends on it through 2 imports. All are likely relations, not proven imports.",
    );
    // Below the user's threshold the hint is not followed.
    expect(connect(g, "a.ts", "d.ts", 0.8)).toEqual({ kind: "none" });
  });

  it("says when neither depends on the other", () => {
    const c = connect(g, "c.ts", "e.ts", 0.5);
    expect(c).toEqual({ kind: "none" });
    expect(connectionSentence(c)).toBe("Neither file depends on the other.");
  });

  it("counts the hints in a mixed chain", () => {
    const mixed: Graph = {
      ...g,
      edges: [edge("a.ts", "b.ts"), edge("b.ts", "c.ts", 0.6)],
    };
    expect(connectionSentence(connect(mixed, "a.ts", "c.ts", 0.5))).toBe(
      "This file depends on it through 2 imports. 1 of them is a likely relation, not a proven import.",
    );
  });
});
