import fs from "node:fs";
import { describe, expect, it } from "vitest";
import { GRAPH_SCHEMA_VERSION, Graph } from "@epoch-dev/core";

// The demo's precomputed data (scripts/site-data.mjs): for every pinned
// repository, the CLI's graph, where it came from, and its license.
const data = new URL("../data/", import.meta.url);
const read = (name: string) => fs.readFileSync(new URL(name, data), "utf8");

interface Repo {
  readonly id: string;
  readonly name: string;
  readonly url: string;
  readonly commit: string;
  readonly license: string;
  /** A report from the project's own tests, made once (data/test-coverage/README.md). */
  readonly coverage?: { readonly report: string };
}
const repos = JSON.parse(read("repos.json")) as Repo[];
const findingsReport = fs.readFileSync(
  new URL("../../../docs/benchmarks/findings.md", import.meta.url),
  "utf8",
);

describe.each(repos)("$name", (repo) => {
  const graph = Graph.parse(JSON.parse(read(`${repo.id}.graph.json`)));
  const meta = JSON.parse(read(`${repo.id}.meta.json`)) as {
    commit: string;
    license: string;
    copyright: string;
    counts: { nodes: number; edges: number; findings: number; covered: number };
    madeWith: { command: string; coverage?: { report: string } };
  };

  it("is the CLI's graph in the current schema", () => {
    expect(graph.schemaVersion).toBe(GRAPH_SCHEMA_VERSION);
    expect(graph.nodes.length).toBeGreaterThan(0);
    expect(meta.counts).toEqual({
      nodes: graph.nodes.length,
      edges: graph.edges.length,
      findings: graph.findings.length,
      covered: graph.nodes.filter((n) => n.metrics.coverage !== undefined)
        .length,
    });
  });

  it("uses the coverage report made from the project's own tests", () => {
    if (repo.coverage === undefined) return;
    expect(meta.madeWith.coverage?.report).toBe(repo.coverage.report);
    expect(meta.madeWith.command).toContain(
      `--coverage ${repo.coverage.report}`,
    );
    expect(read(repo.coverage.report).length).toBeGreaterThan(0);
    expect(meta.counts.covered).toBeGreaterThan(0);
  });

  it("is canonical: repo-relative ids, no machine paths", () => {
    const text = read(`${repo.id}.graph.json`);
    for (const node of graph.nodes) {
      expect(node.id).not.toMatch(/^\/|^[A-Za-z]:|\\/);
    }
    expect(text).not.toMatch(/"\/(?:home|Users|tmp|root)\//);
    expect(text).not.toMatch(/[A-Za-z]:\\\\/);
  });

  it("was made with the repository's history (risk tiers need git)", () => {
    expect(graph.nodes.some((n) => n.metrics.risk !== undefined)).toBe(true);
  });

  it("is pinned to the commit the benchmarks use", () => {
    expect(meta.commit).toBe(repo.commit);
    expect(repo.commit).toMatch(/^[0-9a-f]{40}$/);
    const slug = new URL(repo.url).pathname.slice(1);
    expect(findingsReport).toMatch(
      new RegExp(
        `\\| ${slug.replace("/", "\\/")}\\s+\\| ${repo.commit.slice(0, 12)} `,
      ),
    );
  });

  it("carries the repository's license", () => {
    expect(meta.license).toBe(repo.license);
    const license = read(`${repo.id}.LICENSE.txt`);
    expect(meta.copyright).not.toBe("");
    expect(license).toContain(meta.copyright);
  });
});
