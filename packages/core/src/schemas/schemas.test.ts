import { describe, expect, it } from "vitest";
import {
  AnalysisMeta,
  FileFacts,
  FlagPattern,
  Graph,
  GraphNode,
  GRAPH_SCHEMA_VERSION,
  RawImport,
  Resolution,
} from "./index.js";

const node: GraphNode = {
  id: "src/a.ts",
  kind: "file",
  language: "typescript",
  loc: 3,
  contentHash: "abc",
  exports: ["a"],
  externals: ["react"],
  flags: [],
  metrics: { fanIn: 0, fanOut: 1 },
};

const graph: Graph = {
  schemaVersion: GRAPH_SCHEMA_VERSION,
  nodes: [node],
  edges: [
    {
      source: "src/a.ts",
      target: "src/b.ts",
      kind: "import",
      provenance: "resolver",
      confidence: 1,
      evidence: [],
    },
  ],
  roots: [],
  findings: [],
  unresolved: [
    {
      from: "src/a.ts",
      specifier: null,
      reason: "dynamic-specifier",
      pathPrefix: "src/pages/",
      line: 2,
    },
  ],
};

describe("contract schemas", () => {
  it("accept a valid graph", () => {
    expect(Graph.parse(graph)).toEqual(graph);
  });

  it("allow churn and risk to be absent until computed (ADR-011)", () => {
    expect(GraphNode.safeParse(node).success).toBe(true);
    const computed = {
      ...node,
      metrics: { fanIn: 0, fanOut: 1, churn90d: 4, riskScore: 55 },
    };
    expect(GraphNode.safeParse(computed).success).toBe(true);
  });

  it("reject unknown keys, so typos cannot slip into a graph", () => {
    expect(Graph.safeParse({ ...graph, cycles: [] }).success).toBe(false);
    expect(
      GraphNode.safeParse({
        ...node,
        metrics: { fanIn: 0, fanOut: 0, churn: 1 },
      }).success,
    ).toBe(false);
  });

  it("reject explicit undefined for optional fields (exact optional)", () => {
    expect(
      GraphNode.safeParse({
        ...node,
        metrics: { fanIn: 0, fanOut: 0, riskScore: undefined },
      }).success,
    ).toBe(false);
  });

  it("reject out-of-range values", () => {
    const badEdge = { ...graph.edges[0], confidence: 1.5 };
    expect(Graph.safeParse({ ...graph, edges: [badEdge] }).success).toBe(false);
    const badLine = { ...graph.unresolved[0], line: 0 };
    expect(Graph.safeParse({ ...graph, unresolved: [badLine] }).success).toBe(
      false,
    );
  });

  it("parse raw imports and file facts", () => {
    const imp: RawImport = {
      kind: "dynamic",
      specifier: null,
      dynamicPrefix: "./pages/",
      typeOnly: false,
      names: [],
      line: 7,
    };
    expect(RawImport.parse(imp)).toEqual(imp);
    const facts: FileFacts = {
      imports: [imp],
      exports: [
        { name: "Card", from: { specifier: "./Card", imported: "Card" } },
      ],
      exportAllFrom: ["./Button"],
      flagUsages: [],
      constantConditions: [],
      isGenerated: false,
      loc: 12,
    };
    expect(FileFacts.parse(facts)).toEqual(facts);
  });

  it("discriminate resolutions by kind", () => {
    expect(Resolution.parse({ kind: "external", name: "react" })).toEqual({
      kind: "external",
      name: "react",
    });
    expect(
      Resolution.safeParse({ kind: "external", target: "react" }).success,
    ).toBe(false);
    expect(
      Resolution.safeParse({ kind: "unresolved", reason: "nope" }).success,
    ).toBe(false);
  });

  it("require flag patterns to cite a docs URL", () => {
    const pattern = {
      id: "openfeature.get-boolean-value",
      provider: "openfeature",
      language: "typescript",
      callee: "getBooleanValue",
      keyArgIndex: 0,
      importHints: ["@openfeature/server-sdk"],
      source: "not a url",
    };
    expect(FlagPattern.safeParse(pattern).success).toBe(false);
  });

  it("accept analysis metadata", () => {
    const meta: AnalysisMeta = {
      epochVersion: "0.0.0",
      schemaVersion: 1,
      adapters: [{ id: "typescript", version: "1", tier: "A" }],
      timingsMs: {
        discover: 1,
        changes: 1,
        parse: 2,
        resolve: 3,
        graph: 4,
        score: 0,
        total: 10,
      },
      counts: {
        filesAnalyzed: 1,
        nodes: 1,
        edges: 0,
        externals: 0,
        unresolved: 0,
        skipped: 1,
        parseErrors: 1,
        cacheHits: 0,
        cacheMisses: 1,
        rehashed: 1,
      },
      skipped: [{ path: "big.js", reason: "too-large" }],
      parseErrors: ["broken.ts"],
      cycles: [],
      host: { platform: "linux", arch: "x64", node: "24.21.0" },
      git: { status: "off" },
      coverage: null,
    };
    expect(AnalysisMeta.parse(meta)).toEqual(meta);
  });
});
