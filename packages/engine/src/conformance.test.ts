import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  compareCodeUnits,
  type GraphEdge,
  type UnresolvedImport,
} from "@epoch-dev/core";
import { analyze } from "./analyze.js";

/**
 * The shared conformance suite (CLAUDE.md "Language adapter interface"):
 * every case under fixtures/<language>/conformance/<case>/ is a mini repo
 * with an expected.json. node ids, edges (with evidence), externals and
 * unresolved imports are compared exactly. Python (M3) and Go (M4) add
 * their own case folders; the harness stays the same.
 */
const FIXTURES = fileURLToPath(new URL("../../../fixtures/", import.meta.url));
const REGISTERED_ADAPTERS = new Set(["typescript"]);
const REQUIRED_CASES: Readonly<Record<string, number>> = { typescript: 16 };

interface Expected {
  nodes: string[];
  edges: Pick<GraphEdge, "source" | "target" | "kind" | "evidence">[];
  externals: Record<string, string[]>;
  unresolved: UnresolvedImport[];
}

interface Case {
  language: string;
  name: string;
  dir: string;
  adapters: string[];
}

// eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters -- typed view of trusted fixture JSON
function readJson<T>(file: string): T {
  return JSON.parse(fs.readFileSync(file, "utf8")) as T;
}

function listCases(): Case[] {
  const cases: Case[] = [];
  for (const language of fs.readdirSync(FIXTURES).sort()) {
    const root = path.join(FIXTURES, language, "conformance");
    if (!fs.existsSync(root)) continue;
    for (const name of fs.readdirSync(root).sort()) {
      const dir = path.join(root, name);
      if (!fs.statSync(dir).isDirectory()) continue;
      const meta = readJson<{ adapters: string[] }>(
        path.join(dir, "case.json"),
      );
      cases.push({ language, name, dir, adapters: meta.adapters });
    }
  }
  return cases;
}

const edgeKey = (e: Pick<GraphEdge, "source" | "target" | "kind">): string =>
  `${e.source}\u0000${e.target}\u0000${e.kind}`;

const cases = listCases();

describe("conformance suite", () => {
  it("contains every required case", () => {
    for (const [language, count] of Object.entries(REQUIRED_CASES)) {
      expect(cases.filter((c) => c.language === language)).toHaveLength(count);
    }
  });

  for (const c of cases) {
    const applies = c.adapters.some((a) => REGISTERED_ADAPTERS.has(a));
    it.runIf(applies)(`${c.language}/${c.name}`, async () => {
      const expected = readJson<Expected>(path.join(c.dir, "expected.json"));
      const { graph } = await analyze(c.dir);

      expect(graph.nodes.map((n) => n.id)).toEqual(
        [...expected.nodes].sort(compareCodeUnits),
      );
      expect(
        graph.edges.map((e) => ({
          source: e.source,
          target: e.target,
          kind: e.kind,
          evidence: e.evidence,
        })),
      ).toEqual(
        [...expected.edges].sort((a, b) =>
          compareCodeUnits(edgeKey(a), edgeKey(b)),
        ),
      );
      for (const e of graph.edges) {
        expect(e.provenance).toBe("resolver");
        expect(e.confidence).toBe(1);
      }
      for (const n of graph.nodes) {
        expect(n.externals, `externals of ${n.id}`).toEqual(
          expected.externals[n.id] ?? [],
        );
      }
      expect(graph.unresolved).toEqual(expected.unresolved);
    });
  }
});
