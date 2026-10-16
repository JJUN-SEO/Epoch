import { describe, expect, it } from "vitest";
import type { CandidatePair, ScoredRelation } from "../interfaces/services.js";
import { cochangeCandidates } from "./cochange.js";
import { embeddingCandidates } from "./embeddings.js";
import { hintEdges, mergeCandidates } from "./edges.js";
import { sharedStringCandidates } from "./strings.js";

describe("cochangeCandidates", () => {
  it("counts commits that changed both files, in both directions, above the support", () => {
    const commits = [
      ["a.ts", "b.ts"],
      ["a.ts", "b.ts", "c.ts"],
      ["a.ts", "b.ts"],
      ["a.ts"],
      ["b.ts", "c.ts"],
    ];
    expect(
      cochangeCandidates(commits, { maxFiles: 10, minSupport: 2 }),
    ).toEqual([
      {
        source: "a.ts",
        target: "b.ts",
        signals: {
          cochange: { together: 3, sourceCommits: 4, targetCommits: 4 },
        },
      },
      {
        source: "b.ts",
        target: "a.ts",
        signals: {
          cochange: { together: 3, sourceCommits: 4, targetCommits: 4 },
        },
      },
      {
        source: "b.ts",
        target: "c.ts",
        signals: {
          cochange: { together: 2, sourceCommits: 4, targetCommits: 2 },
        },
      },
      {
        source: "c.ts",
        target: "b.ts",
        signals: {
          cochange: { together: 2, sourceCommits: 2, targetCommits: 4 },
        },
      },
    ]);
  });

  it("skips commits above the size cutoff entirely, and counts a file once per commit", () => {
    const commits = [
      ["a.ts", "b.ts", "c.ts"], // too large at maxFiles 2
      ["a.ts", "b.ts", "a.ts"],
      ["a.ts", "b.ts"],
    ];
    expect(cochangeCandidates(commits, { maxFiles: 2, minSupport: 2 })).toEqual(
      [
        {
          source: "a.ts",
          target: "b.ts",
          signals: {
            cochange: { together: 2, sourceCommits: 2, targetCommits: 2 },
          },
        },
        {
          source: "b.ts",
          target: "a.ts",
          signals: {
            cochange: { together: 2, sourceCommits: 2, targetCommits: 2 },
          },
        },
      ],
    );
  });
});

describe("sharedStringCandidates", () => {
  const files = [
    { id: "pub.ts", strings: ["user.created", "app.version"] },
    { id: "sub.ts", strings: ["user.created", "app.version"] },
    { id: "audit.ts", strings: ["app.version", "audit.trail"] },
    { id: "other.ts", strings: ["app.version"] },
    { id: "log.ts", strings: ["audit.trail"] },
  ];

  it("links files by strings few files use, weighted by rarity, rarest first", () => {
    const pairs = sharedStringCandidates(files, { maxFiles: 3 });
    // app.version is in 4 files, above maxFiles: it links nothing.
    const weight = Math.log(5 / 2);
    expect(pairs).toEqual([
      {
        source: "audit.ts",
        target: "log.ts",
        signals: { strings: { shared: ["audit.trail"], weight } },
      },
      {
        source: "log.ts",
        target: "audit.ts",
        signals: { strings: { shared: ["audit.trail"], weight } },
      },
      {
        source: "pub.ts",
        target: "sub.ts",
        signals: { strings: { shared: ["user.created"], weight } },
      },
      {
        source: "sub.ts",
        target: "pub.ts",
        signals: { strings: { shared: ["user.created"], weight } },
      },
    ]);
  });

  it("counts a node once when several of its files share a string (Go packages)", () => {
    const pairs = sharedStringCandidates(
      [
        { id: "pkg:a", strings: ["route.users"] },
        { id: "pkg:a", strings: ["route.users"] },
        { id: "pkg:b", strings: ["route.users"] },
        { id: "pkg:c", strings: [] },
      ],
      { maxFiles: 5 },
    );
    expect(pairs.map((p) => [p.source, p.target])).toEqual([
      ["pkg:a", "pkg:b"],
      ["pkg:b", "pkg:a"],
    ]);
  });
});

describe("hintEdges", () => {
  const candidates: CandidatePair[] = [
    {
      source: "a.ts",
      target: "b.ts",
      signals: {
        cochange: { together: 3, sourceCommits: 4, targetCommits: 4 },
        strings: { shared: ["user.created"], weight: 0.9 },
      },
    },
    {
      source: "b.ts",
      target: "a.ts",
      signals: { strings: { shared: ["user.created"], weight: 0.9 } },
    },
    {
      source: "c.ts",
      target: "a.ts",
      signals: { embedding: { cosine: 0.8123 } },
    },
    { source: "d.ts", target: "a.ts", signals: { embedding: { cosine: 0.4 } } },
  ];
  const scored: ScoredRelation[] = [
    { source: "a.ts", target: "b.ts", probability: 0.7, rationale: "" },
    { source: "b.ts", target: "a.ts", probability: 1, rationale: "" },
    { source: "c.ts", target: "a.ts", probability: 0.45678, rationale: "" },
    { source: "d.ts", target: "a.ts", probability: 0.05, rationale: "" },
  ];

  it("takes the strongest signal's kind, keeps confidence below 1, drops the floor and fact-covered pairs", () => {
    const edges = hintEdges(candidates, scored, {
      floor: 0.1,
      perNode: 8,
      byModel: false,
      facts: new Set(["b.ts\u0000a.ts"]),
    });
    expect(edges).toEqual([
      {
        source: "a.ts",
        target: "b.ts",
        kind: "cochange",
        provenance: "git-cochange",
        confidence: 0.7,
        evidence: [
          "changed in 3 of the 4 commits that changed b.ts",
          'both use the rare string "user.created"',
        ],
      },
      {
        source: "c.ts",
        target: "a.ts",
        kind: "semantic",
        provenance: "embedding",
        confidence: 0.457,
        evidence: ["similar content (cosine 0.81)"],
      },
    ]);
  });

  it("keeps the strongest hints per node, and marks a model's edges as model semantic hints", () => {
    const many: CandidatePair[] = ["b", "c", "d"].map((t) => ({
      source: "a.ts",
      target: `${t}.ts`,
      signals: { strings: { shared: ["x.y", "y.z", "z.w", "w.v"], weight: 1 } },
    }));
    const scores: ScoredRelation[] = [
      {
        source: "a.ts",
        target: "b.ts",
        probability: 0.5,
        rationale: "same event",
      },
      {
        source: "a.ts",
        target: "c.ts",
        probability: 0.9,
        rationale: "same event",
      },
      {
        source: "a.ts",
        target: "d.ts",
        probability: 0.5,
        rationale: "same event",
      },
    ];
    const edges = hintEdges(many, scores, {
      floor: 0.1,
      perNode: 2,
      byModel: true,
      facts: new Set(),
    });
    expect(
      edges.map((e) => [e.target, e.kind, e.provenance, e.confidence]),
    ).toEqual([
      ["b.ts", "semantic", "model", 0.5],
      ["c.ts", "semantic", "model", 0.9],
    ]);
    expect(edges[0]?.evidence).toEqual([
      'both use the rare strings "x.y", "y.z", "z.w" and 1 more',
      "a model scored it: same event",
    ]);
  });
});

describe("mergeCandidates", () => {
  it("joins every generator's signals for the same directed pair", () => {
    expect(
      mergeCandidates(
        [
          {
            source: "b.ts",
            target: "a.ts",
            signals: {
              cochange: { together: 3, sourceCommits: 3, targetCommits: 5 },
            },
          },
        ],
        [
          {
            source: "b.ts",
            target: "a.ts",
            signals: { strings: { shared: ["x.y"], weight: 1 } },
          },
          {
            source: "a.ts",
            target: "b.ts",
            signals: { strings: { shared: ["x.y"], weight: 1 } },
          },
        ],
      ),
    ).toEqual([
      {
        source: "a.ts",
        target: "b.ts",
        signals: { strings: { shared: ["x.y"], weight: 1 } },
      },
      {
        source: "b.ts",
        target: "a.ts",
        signals: {
          cochange: { together: 3, sourceCommits: 3, targetCommits: 5 },
          strings: { shared: ["x.y"], weight: 1 },
        },
      },
    ]);
  });
});

describe("embeddingCandidates", () => {
  const v = (...xs: number[]) => Float32Array.from(xs);

  it("proposes each node's nearest neighbors above the cutoff, in both directions", () => {
    const pairs = embeddingCandidates(
      [
        { id: "a.ts", vector: v(1, 0, 0) },
        { id: "b.ts", vector: v(0.9, 0.1, 0) },
        { id: "c.ts", vector: v(0, 1, 0) },
        { id: "d.ts", vector: v(0, 0, 0) }, // no direction: skipped
      ],
      { k: 1, minCosine: 0.5 },
    );
    const cos = Math.round((0.9 / Math.hypot(0.9, 0.1)) * 1e4) / 1e4;
    expect(pairs).toEqual([
      {
        source: "a.ts",
        target: "b.ts",
        signals: { embedding: { cosine: cos } },
      },
      {
        source: "b.ts",
        target: "a.ts",
        signals: { embedding: { cosine: cos } },
      },
    ]);
  });

  it("keeps only k neighbors per node, and averages a package's files", () => {
    const pairs = embeddingCandidates(
      [
        { id: "x", vector: v(1, 0) },
        { id: "pkg:p", vector: v(1, 0.2) },
        { id: "pkg:p", vector: v(1, -0.2) }, // mean points along x
        { id: "y", vector: v(1, 0.5) },
      ],
      { k: 1, minCosine: 0 },
    );
    expect(pairs.find((p) => p.source === "x")?.target).toBe("pkg:p");
    expect(
      pairs.find((p) => p.source === "x" && p.target === "pkg:p")?.signals
        .embedding?.cosine,
    ).toBe(1);
  });
});
