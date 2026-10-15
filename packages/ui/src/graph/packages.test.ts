import { describe, expect, it } from "vitest";
import type { Graph, GraphEdge, GraphNode } from "@epoch-dev/core";
import { PACKAGE_DIRECTORY_EVIDENCE } from "@epoch-dev/core";
import { packageFolders } from "./packages.js";

const node = (id: string): GraphNode => ({
  id,
  kind: id.startsWith("pkg:") ? "package" : "file",
  language: "go",
  loc: 1,
  contentHash: id,
  exports: [],
  externals: [],
  flags: [],
  metrics: { fanIn: 0, fanOut: 0 },
});

const testLink = (file: string, pkg: string): GraphEdge => ({
  source: file,
  target: pkg,
  kind: "import",
  provenance: "resolver",
  confidence: 1,
  evidence: [PACKAGE_DIRECTORY_EVIDENCE],
});

const graph = (ids: string[], edges: GraphEdge[] = []): Graph => ({
  schemaVersion: 1,
  nodes: ids.map(node),
  edges,
  roots: [],
  findings: [],
  unresolved: [],
});

describe("packageFolders", () => {
  it("learns the module's directory from test files linked to their package", () => {
    const g = graph(
      [
        "internal/build/build_test.go",
        "pkg:github.com/cli/cli/v2",
        "pkg:github.com/cli/cli/v2/internal/build",
        "pkg:github.com/cli/cli/v2/pkg/cmd",
      ],
      [
        testLink(
          "internal/build/build_test.go",
          "pkg:github.com/cli/cli/v2/internal/build",
        ),
      ],
    );
    expect(Object.fromEntries(packageFolders(g))).toEqual({
      "pkg:github.com/cli/cli/v2": "",
      "pkg:github.com/cli/cli/v2/internal/build": "internal/build",
      "pkg:github.com/cli/cli/v2/pkg/cmd": "pkg/cmd",
    });
  });

  it("maps each module of a workspace by its own anchor", () => {
    const g = graph(
      [
        "services/api/h/h_test.go",
        "libs/x/x_test.go",
        "pkg:example.com/api/h",
        "pkg:example.com/api/z",
        "pkg:example.org/x",
      ],
      [
        testLink("services/api/h/h_test.go", "pkg:example.com/api/h"),
        testLink("libs/x/x_test.go", "pkg:example.org/x"),
      ],
    );
    expect(Object.fromEntries(packageFolders(g))).toEqual({
      "pkg:example.com/api/h": "services/api/h",
      "pkg:example.com/api/z": "services/api/z",
      "pkg:example.org/x": "libs/x",
    });
  });

  it("falls back to the import-path prefix all packages share", () => {
    const g = graph([
      "pkg:example.com/m",
      "pkg:example.com/m/a",
      "pkg:example.com/m/a/b",
    ]);
    expect(Object.fromEntries(packageFolders(g))).toEqual({
      "pkg:example.com/m": "",
      "pkg:example.com/m/a": "a",
      "pkg:example.com/m/a/b": "a/b",
    });
    expect(packageFolders(graph(["a.ts"])).size).toBe(0);
  });
});
