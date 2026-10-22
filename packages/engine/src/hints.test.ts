import childProcess from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  isHintEdge,
  type Embedder,
  type Graph,
  type RelationScorer,
} from "@epoch-dev/core";
import { analyze } from "./analyze.js";
import { MemoryCacheStore } from "./cache/memory-store.js";
import { toPosix } from "./discover.js";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0))
    fs.rmSync(d, { recursive: true, force: true });
});

const HEAD_TIME = 1_780_000_000;
const DAY = 86_400;

function project(files: Record<string, string>): string {
  const dir = toPosix(
    fs.realpathSync.native(
      fs.mkdtempSync(path.join(os.tmpdir(), "epoch-hints-")),
    ),
  );
  dirs.push(dir);
  for (const [rel, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), text);
  }
  return dir;
}

function git(dir: string, args: string[], daysBeforeHead = 0): void {
  const when = `${String(HEAD_TIME - daysBeforeHead * DAY)} +0000`;
  childProcess.execFileSync("git", args, {
    cwd: dir,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@example.com",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@example.com",
      GIT_AUTHOR_DATE: when,
      GIT_COMMITTER_DATE: when,
    },
  });
}

/** Appends a line to each file, then commits them together. */
function touch(dir: string, files: string[], daysBeforeHead: number): void {
  for (const f of files) fs.appendFileSync(path.join(dir, f), "// edit\n");
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-q", "--no-gpg-sign", "-m", "edit"], daysBeforeHead);
}

function repo(files: Record<string, string>): string {
  const dir = project(files);
  git(dir, ["init", "-q", "-b", "main"]);
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-q", "--no-gpg-sign", "-m", "init"], 300);
  return dir;
}

const hints = (g: Graph) =>
  g.edges.filter(isHintEdge).map((e) => `${e.source}>${e.target} ${e.kind}`);

describe("the Enrich stage", { timeout: 60_000 }, () => {
  it("adds co-change hints, skipping bulk commits and pairs a fact edge already covers", async () => {
    const dir = repo({
      "src/core.ts": "export const core = 1;\n",
      "src/a.ts": 'import { core } from "./core";\nexport const a = core;\n',
      "src/b.ts": "export const b = 2;\n",
      "src/c.ts": "export const c = 3;\n",
    });
    for (const day of [200, 100, 50]) touch(dir, ["src/a.ts", "src/b.ts"], day);
    for (const day of [40, 30, 20])
      touch(dir, ["src/a.ts", "src/core.ts"], day);
    // Bulk: above the size cutoff, like the initial commit.
    touch(dir, ["src/a.ts", "src/b.ts", "src/c.ts", "src/core.ts"], 10);

    let seen: readonly string[] = [];
    const { graph, meta } = await analyze(dir, {
      hints: {
        cochange: { maxFiles: 3 },
        onCandidates: ({ candidates }) => {
          seen = candidates.map((c) => `${c.source}>${c.target}`);
        },
      },
    });
    // Every candidate, the fact-covered one too, before scoring.
    expect(seen).toEqual([
      "src/a.ts>src/b.ts",
      "src/a.ts>src/core.ts",
      "src/b.ts>src/a.ts",
      "src/core.ts>src/a.ts",
    ]);
    // a imports core: the hint a>core adds nothing; core>a (core changes
    // when a does) is a new relation.
    expect(hints(graph)).toEqual([
      "src/a.ts>src/b.ts cochange",
      "src/b.ts>src/a.ts cochange",
      "src/core.ts>src/a.ts cochange",
    ]);
    const ab = graph.edges.find(
      (e) => e.source === "src/a.ts" && e.target === "src/b.ts",
    );
    expect(ab).toMatchObject({
      provenance: "git-cochange",
      evidence: ["changed in 3 of the 3 commits that changed src/b.ts"],
    });
    const ba = graph.edges.find(
      (e) => e.source === "src/b.ts" && e.target === "src/a.ts",
    );
    // a changed with b every time b changed; b with a only half the time.
    expect(ab?.confidence).toBeGreaterThan(ba?.confidence ?? 1);
    expect(ab?.confidence).toBeLessThan(1);
    expect(meta.hints).toEqual({
      cochange: { status: "usable", commits: 6, pairs: 4 },
      strings: { pairs: 0 },
      embeddings: { status: "off", pairs: 0 },
      scorer: "heuristic",
      edges: 3,
    });
    expect(meta.timingsMs.enrich).toBeGreaterThanOrEqual(0);
    // Hints never count as dependencies.
    expect(graph.nodes.find((n) => n.id === "src/a.ts")?.metrics.fanIn).toBe(0);

    // The same commit gives the same hints, from the cache or not.
    const cache = new MemoryCacheStore();
    const first = await analyze(dir, { cache });
    const second = await analyze(dir, { cache });
    expect(second.graph).toEqual(first.graph);
    expect((await analyze(dir)).graph).toEqual(first.graph);
  });

  it("lifts Go files to their package nodes", async () => {
    const dir = repo({
      "go.mod": "module example.com/m\n",
      "x/a.go": "package x\n\nconst A = 1\n",
      "x/b.go": "package x\n\nconst B = 2\n",
      "y/c.go": "package y\n\nconst C = 3\n",
    });
    touch(dir, ["x/a.go", "y/c.go"], 30);
    touch(dir, ["x/a.go", "x/b.go", "y/c.go"], 20);
    touch(dir, ["x/b.go", "y/c.go"], 10);
    const { graph } = await analyze(dir);
    expect(hints(graph)).toEqual([
      "pkg:example.com/m/x>pkg:example.com/m/y cochange",
      "pkg:example.com/m/y>pkg:example.com/m/x cochange",
    ]);
    expect(graph.edges[0]?.evidence).toEqual([
      "changed in 4 of the 4 commits that changed pkg:example.com/m/y",
    ]);
  });

  it("links files by rare shared strings, with the scorer it is given, and can be switched off", async () => {
    const dir = project({
      "src/pub.ts": 'export const E = "user.created";\n',
      "src/sub.ts": 'export const S = "user.created";\n',
      "src/other.ts": "export const O = 1;\n",
      "src/more.ts": "export const M = 2;\n",
    });
    const fixed: RelationScorer = {
      scoreRelations: (candidates) =>
        Promise.resolve(
          candidates.map((c) => ({
            source: c.source,
            target: c.target,
            probability: 0.6,
            rationale: "",
          })),
        ),
      classifyFiles: () => Promise.resolve([]),
    };
    const { graph, meta } = await analyze(dir, {
      hints: { scorer: { id: "fixed", scorer: fixed, byModel: false } },
    });
    expect(graph.edges.filter(isHintEdge)).toEqual([
      {
        source: "src/pub.ts",
        target: "src/sub.ts",
        kind: "shared-string",
        provenance: "shared-string",
        confidence: 0.6,
        evidence: ['both use the rare string "user.created"'],
      },
      {
        source: "src/sub.ts",
        target: "src/pub.ts",
        kind: "shared-string",
        provenance: "shared-string",
        confidence: 0.6,
        evidence: ['both use the rare string "user.created"'],
      },
    ]);
    expect(meta.hints).toMatchObject({
      cochange: { status: "not-a-repo" },
      strings: { pairs: 2 },
      scorer: "fixed",
      edges: 2,
    });

    const off = await analyze(dir, { hints: false });
    expect(off.graph.edges.filter(isHintEdge)).toEqual([]);
    // Hints add edges beside the facts; they change no fact edge, and no
    // finding appears or disappears because of them.
    expect(off.graph.edges).toEqual(graph.edges.filter((e) => !isHintEdge(e)));
    expect(off.graph.findings.map((f) => f.id)).toEqual(
      graph.findings.map((f) => f.id),
    );
    expect(off.meta.hints).toEqual({
      cochange: { status: "off", commits: 0, pairs: 0 },
      strings: { pairs: 0 },
      embeddings: { status: "off", pairs: 0 },
      scorer: "none",
      edges: 0,
    });
    const noHistory = await analyze(dir, { history: false });
    expect(noHistory.meta.hints.cochange.status).toBe("off");
  });
  it("adds similarity candidates from a local embedding model, cached by content, and reports a failing model", async () => {
    const dir = project({
      "src/auth/login.ts": 'export const login = "token";\n// token token\n',
      "src/auth/session.ts": "export const session = 1; // token\n",
      "src/ui/button.ts": "export const button = 1; // render\n",
      "src/ui/icon.ts": "export const icon = 1; // render render\n",
    });
    const texts: string[] = [];
    const count = (text: string, word: string) => text.split(word).length - 1;
    const embedder: Embedder = {
      modelId: "fake-1",
      embed: (batch) => {
        texts.push(...batch);
        return Promise.resolve(
          batch.map((t) =>
            Float32Array.from([count(t, "token"), count(t, "render"), 0.001]),
          ),
        );
      },
    };
    const fixed: RelationScorer = {
      scoreRelations: (candidates) =>
        Promise.resolve(
          candidates.map((c) => ({
            source: c.source,
            target: c.target,
            probability: 0.6,
            rationale: "",
          })),
        ),
      classifyFiles: () => Promise.resolve([]),
    };
    const cache = new MemoryCacheStore();
    const opts = {
      cache,
      hints: {
        embeddings: { embedder },
        scorer: { id: "fixed", scorer: fixed, byModel: false },
      },
    };
    const { graph, meta } = await analyze(dir, opts);
    expect(hints(graph)).toEqual([
      "src/auth/login.ts>src/auth/session.ts semantic",
      "src/auth/session.ts>src/auth/login.ts semantic",
      "src/ui/button.ts>src/ui/icon.ts semantic",
      "src/ui/icon.ts>src/ui/button.ts semantic",
    ]);
    const edge = graph.edges.find((e) => e.source === "src/ui/button.ts");
    expect(edge).toMatchObject({
      provenance: "embedding",
      evidence: ["similar content (cosine 1.00)"],
    });
    expect(meta.hints.embeddings).toEqual({
      status: "ready",
      model: "fake-1",
      pairs: 4,
    });
    // The text embedded is the path and the start of the file.
    expect(texts).toContain(
      "src/ui/button.ts\nexport const button = 1; // render\n",
    );

    // Unchanged files are not embedded again.
    texts.length = 0;
    expect((await analyze(dir, opts)).graph).toEqual(graph);
    expect(texts).toEqual([]);

    const broken: Embedder = {
      modelId: "missing-model",
      embed: () => Promise.reject(new Error("model files not found")),
    };
    const off = await analyze(dir, {
      hints: { embeddings: { embedder: broken } },
    });
    expect(off.meta.hints.embeddings).toEqual({
      status: "unavailable",
      model: "missing-model",
      pairs: 0,
    });
  });
});
