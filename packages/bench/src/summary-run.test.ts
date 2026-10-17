import path from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import {
  FsReader,
  MemoryCacheStore,
  SummaryStore,
  analyze,
  toPosix,
  type AnalyzeResult,
  type SummarySource,
} from "@epoch-dev/engine";
import {
  estimateOnly,
  runSummaryJob,
  type Answer,
  type Generate,
} from "./summary-run.js";

const FIXTURE = toPosix(
  fileURLToPath(
    new URL(
      "../../../fixtures/typescript/conformance/relative",
      import.meta.url,
    ),
  ),
);
const MODEL = { provider: "anthropic", model: "m" } as const;

let analyzed: AnalyzeResult;

beforeAll(async () => {
  analyzed = await analyze(FIXTURE, { history: false });
});

function source(edit: Record<string, string> = {}): SummarySource {
  const reader = new FsReader(FIXTURE);
  return {
    root: FIXTURE,
    graph: analyzed.graph,
    packages: analyzed.packages,
    readText: (rel) =>
      edit[rel] ?? reader.readFile(path.posix.join(FIXTURE, rel)),
  };
}

/** Answers every plan with text that changes whenever the plan's input does. */
function counting(): Generate & { calls: string[] } {
  const calls: string[] = [];
  const answer = async (plan: Parameters<Generate>[0]): Promise<Answer> => {
    calls.push(plan.subject);
    const est = await estimateOnly()(plan);
    return { ...est, costUsd: 0.001 };
  };
  return Object.assign(answer, { calls });
}

describe("runSummaryJob", () => {
  it("summarizes every file then every folder once, and nothing again while unchanged", async () => {
    const store = new SummaryStore(new MemoryCacheStore(), FIXTURE);
    const gen = counting();
    const full = await runSummaryJob(source(), store, MODEL, gen);
    expect(gen.calls).toEqual(["src/b.ts", "src/a.ts", "dir:src", "dir:"]);
    expect(full.sent.map((r) => [r.kind, r.status, r.stored])).toEqual([
      ["file", "missing", true],
      ["file", "missing", true],
      ["dir", "missing", true],
      ["dir", "missing", true],
    ]);
    expect(full.fresh).toBe(0);

    const again = await runSummaryJob(source(), store, MODEL, gen);
    expect(again.sent).toEqual([]);
    expect(again.fresh).toBe(4);
    expect(gen.calls).toHaveLength(4);
  });

  it("after an edit, sends the file, what imports it, and the folders above", async () => {
    const store = new SummaryStore(new MemoryCacheStore(), FIXTURE);
    await runSummaryJob(source(), store, MODEL, counting());
    const gen = counting();
    const edited = await runSummaryJob(
      source({ "src/b.ts": "export const b = 2;\n" }),
      store,
      MODEL,
      gen,
    );
    expect(edited.sent.map((r) => [r.subject, r.status])).toEqual([
      ["src/b.ts", "stale-file"],
      ["src/a.ts", "stale-dependencies"],
      ["dir:src", "stale-file"],
      ["dir:", "stale-file"],
    ]);

    // Editing the importer alone leaves the file it imports fresh.
    const gen2 = counting();
    const second = await runSummaryJob(
      source({
        "src/b.ts": "export const b = 2;\n",
        "src/a.ts": "import { b } from './b';\nexport const a = b + 1;\n",
      }),
      store,
      MODEL,
      gen2,
    );
    expect(gen2.calls).toEqual(["src/a.ts", "dir:src", "dir:"]);
    expect(second.fresh).toBe(1);
  });

  it("the estimate is an upper bound: full-length text, the output cap, and the byte estimate", async () => {
    const store = new SummaryStore(new MemoryCacheStore(), FIXTURE);
    const run = await runSummaryJob(source(), store, MODEL, estimateOnly());
    for (const row of run.sent) {
      expect(row.outputTokens).toBe(1024);
      expect(row.inputTokens).toBeGreaterThan(0);
      expect(row.costUsd).toBe(0);
    }
    expect(store.latest("src/b.ts")?.text.length).toBeGreaterThan(1900);
  });

  it("never sends a file that looks like it holds secrets, and still sums up its folder", async () => {
    const store = new SummaryStore(new MemoryCacheStore(), FIXTURE);
    const gen = counting();
    const run = await runSummaryJob(
      source({
        "src/b.ts": "-----BEGIN RSA PRIVATE KEY-----\nabc\n",
      }),
      store,
      MODEL,
      gen,
    );
    expect(gen.calls).not.toContain("src/b.ts");
    expect(run.skipped).toEqual([{ subject: "src/b.ts", reason: "secret" }]);
    expect(gen.calls).toContain("dir:src");
  });

  it("keeps what was done when a request stops the run", async () => {
    const store = new SummaryStore(new MemoryCacheStore(), FIXTURE);
    let n = 0;
    const run = await runSummaryJob(source(), store, MODEL, async (plan) => {
      if (++n === 2) throw new Error("the spend cap would be passed");
      return estimateOnly()(plan);
    });
    expect(run.sent.map((r) => r.subject)).toEqual(["src/b.ts"]);
    expect(run.stoppedBy).toBe("the spend cap would be passed");
  });

  it("does not store a refused or cut-off answer", async () => {
    const store = new SummaryStore(new MemoryCacheStore(), FIXTURE);
    const run = await runSummaryJob(source(), store, MODEL, async (plan) => ({
      ...(await estimateOnly()(plan)),
      stop: plan.subject === "src/b.ts" ? "refusal" : "max-tokens",
    }));
    expect(run.sent.map((r) => [r.subject, r.stored])).toEqual([
      ["src/b.ts", false],
      ["src/a.ts", false],
    ]);
    // Folders wait for their children's summaries.
    expect(run.skipped.map((s) => s.reason)).toEqual([
      "children-missing",
      "children-missing",
    ]);
  });
});
