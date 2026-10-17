import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { normalizeLine, sourceLines, type CacheStore } from "@epoch-dev/core";
import { analyze, type AnalyzeResult } from "./analyze.js";
import { MemoryCacheStore } from "./cache/memory-store.js";
import { CACHE_FILE, SqliteCacheStore } from "./cache/sqlite-store.js";
import { FsReader } from "./reader.js";
import {
  SummaryStore,
  planSummary,
  storeSummary,
  type SummaryModelId,
  type SummaryPlan,
  type SummarySource,
} from "./summaries.js";

/*
 * Summaries over the local cache (M7). The model is a fake here: it echoes
 * the source it was sent around a sentence of prose, so the tests show the
 * sanitizer keeps source out of the cache whatever a model answers.
 */

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
});

const FILES: Record<string, string> = {
  "src/config.ts":
    "export const PORT = 8080;\nexport function readConfig() {\n  return { port: PORT };\n}\n",
  "src/server.ts":
    'import { readConfig } from "./config";\nexport function startServer() {\n  const config = readConfig();\n  return config.port;\n}\n',
  "src/secrets.ts": 'export const vault = "named like a secret";\n',
  "src/key.ts":
    "export const pem = `-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBg\n-----END PRIVATE KEY-----`;\n",
  "go.mod": "module example.com/m\n\ngo 1.22\n",
  "pkg/a/a.go": "package a\n\nfunc Alpha() int { return 1 }\n",
  "pkg/a/b.go": "package a\n\nfunc Beta() int { return Alpha() + 1 }\n",
};

function project(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "epoch-summaries-"));
  dirs.push(dir);
  for (const [rel, text] of Object.entries(FILES)) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), text);
  }
  return dir;
}

const HAIKU: SummaryModelId = { provider: "anthropic", model: "m" };

function sourceOf(result: AnalyzeResult): SummarySource {
  const reader = new FsReader(result.root);
  return {
    root: result.root,
    graph: result.graph,
    packages: result.packages,
    readText: (rel) => reader.readFile(`${result.root}/${rel}`),
  };
}

/** The fake model: prose, then everything it was sent in a code block. */
function echo(plan: SummaryPlan & { ok: true }, prose: string, harsh = false) {
  return {
    text: harsh
      ? // Worse: the prompt pasted into the prose, no code block.
        `${prose} ${plan.prompt.user} ${prose}`
      : `${prose}\n\`\`\`\n${plan.prompt.user}\n\`\`\`\nIt is small.`,
    usage: { inputTokens: 100, outputTokens: 20 },
    costUsd: 0.0001,
  };
}

const ok = (plan: SummaryPlan): SummaryPlan & { ok: true } => {
  if (!plan.ok) throw new Error(`not planned: ${plan.reason}`);
  return plan;
};

const NOW = new Date("2026-10-16T12:00:00.000Z");

async function setup(cache: CacheStore = new MemoryCacheStore()) {
  const dir = project();
  const result = await analyze(dir, { hints: false });
  const store = new SummaryStore(cache, result.root);
  const src = sourceOf(result);
  const summarize = (
    subject: string,
    prose: string,
    model = HAIKU,
    harsh = false,
  ) => {
    const plan = ok(planSummary(src, store, subject, model));
    const saved = storeSummary(
      store,
      plan,
      model,
      echo(plan, prose, harsh),
      NOW,
    );
    if (!saved) throw new Error("nothing kept");
    return saved;
  };
  return { dir, result, store, src, summarize, cache };
}

describe("planSummary and storeSummary", () => {
  it("plans a file from its source, and keeps only prose of the answer", async () => {
    const { src, store, summarize } = await setup();
    const first = ok(planSummary(src, store, "src/config.ts", HAIKU));
    expect(first.status.state).toBe("missing");
    expect(first.kind).toBe("file");
    expect(first.used).toEqual([]);
    expect(first.prompt.user).toContain(FILES["src/config.ts"]);
    const saved = summarize("src/config.ts", "Holds the port.");
    expect(saved.text).toBe("Holds the port. It is small.");
    expect(saved).toMatchObject({
      subject: "src/config.ts",
      provider: "anthropic",
      model: "m",
      usage: { inputTokens: 100, outputTokens: 20, costUsd: 0.0001 },
      createdAt: NOW.toISOString(),
    });
    const again = ok(planSummary(src, store, "src/config.ts", HAIKU));
    expect(again.status).toEqual({ state: "fresh", summary: saved });
  });

  it("gives a file its dependencies' summaries, and goes softly stale when one changes", async () => {
    const { src, store, summarize } = await setup();
    summarize("src/config.ts", "Holds the port.");
    const plan = ok(planSummary(src, store, "src/server.ts", HAIKU));
    expect(plan.prompt.user).toContain("- src/config.ts: Holds the port.");
    expect(plan.used.map((r) => r.subject)).toEqual(["src/config.ts"]);
    summarize("src/server.ts", "Starts the server.");
    expect(
      ok(planSummary(src, store, "src/server.ts", HAIKU)).status.state,
    ).toBe("fresh");
    summarize("src/config.ts", "Reads settings.");
    const status = ok(planSummary(src, store, "src/server.ts", HAIKU)).status;
    expect(status.state === "stale" && status.why).toBe("dependencies");
    expect(status.state === "stale" && status.previous.text).toBe(
      "Starts the server. It is small.",
    );
  });

  it("goes stale when the file changes, and finds its summary again when it changes back", async () => {
    const { dir, src, store, summarize } = await setup();
    const saved = summarize("src/config.ts", "Holds the port.");
    const file = path.join(dir, "src/config.ts");
    fs.writeFileSync(
      file,
      `${FILES["src/config.ts"] ?? ""}export const HOST = "x";\n`,
    );
    const changed = ok(planSummary(src, store, "src/config.ts", HAIKU)).status;
    expect(changed).toEqual({ state: "stale", why: "file", previous: saved });
    fs.writeFileSync(file, FILES["src/config.ts"] ?? "");
    expect(ok(planSummary(src, store, "src/config.ts", HAIKU)).status).toEqual({
      state: "fresh",
      summary: saved,
    });
  });

  it("misses with another model, showing the last summary meanwhile", async () => {
    const { src, store, summarize } = await setup();
    const saved = summarize("src/config.ts", "Holds the port.");
    const other = ok(
      planSummary(src, store, "src/config.ts", {
        provider: "local",
        model: "q",
      }),
    );
    expect(other.status).toEqual({
      state: "stale",
      why: "file",
      previous: saved,
    });
  });

  it("never plans a file that looks like a secret, by name or content", async () => {
    const { src, store } = await setup();
    expect(planSummary(src, store, "src/secrets.ts", HAIKU)).toEqual({
      ok: false,
      subject: "src/secrets.ts",
      reason: "secret",
    });
    expect(planSummary(src, store, "src/key.ts", HAIKU)).toMatchObject({
      ok: false,
      reason: "secret",
    });
    expect(planSummary(src, store, "src/nope.ts", HAIKU)).toMatchObject({
      ok: false,
      reason: "not-in-graph",
    });
  });

  it("summarizes a Go package from its member files", async () => {
    const { src, store } = await setup();
    const plan = ok(planSummary(src, store, "pkg:example.com/m/pkg/a", HAIKU));
    expect(plan.kind).toBe("package");
    expect(plan.prompt.user).toContain("(go,");
    expect(plan.prompt.user).toContain(
      `=== pkg/a/a.go ===\n${FILES["pkg/a/a.go"] ?? ""}`,
    );
    expect(plan.prompt.user).toContain(
      `=== pkg/a/b.go ===\n${FILES["pkg/a/b.go"] ?? ""}`,
    );
  });

  it("summarizes a folder from its children's summaries, once they exist", async () => {
    const { src, store, summarize } = await setup();
    const early = planSummary(src, store, "dir:src", HAIKU);
    expect(early).toMatchObject({ ok: false, reason: "children-missing" });
    expect(!early.ok && early.missing).toEqual([
      "src/config.ts",
      "src/server.ts",
    ]);
    summarize("src/config.ts", "Holds the port.");
    summarize("src/server.ts", "Starts the server.");
    const plan = ok(planSummary(src, store, "dir:src", HAIKU));
    expect(plan.kind).toBe("dir");
    expect(plan.prompt.user).toContain("Folder: src");
    expect(plan.prompt.user).toContain(
      "- src/server.ts (file): Starts the server. It is small.",
    );
    // Secret files are not children it waits for, and never in the prompt.
    expect(plan.prompt.user).not.toContain("src/secrets.ts");
    expect(plan.excluded).toEqual(["src/key.ts", "src/secrets.ts"]);
    summarize("dir:src", "The server and its settings.");
    expect(ok(planSummary(src, store, "dir:src", HAIKU)).status.state).toBe(
      "fresh",
    );
    summarize("src/config.ts", "Reads settings.");
    const status = ok(planSummary(src, store, "dir:src", HAIKU)).status;
    expect(status.state === "stale" && status.why).toBe("file");
  });

  it("keeps nothing when the answer is all code", async () => {
    const { src, store } = await setup();
    const plan = ok(planSummary(src, store, "src/config.ts", HAIKU));
    expect(
      storeSummary(
        store,
        plan,
        HAIKU,
        {
          text: "```\ncode\n```",
          usage: { inputTokens: 1, outputTokens: 1 },
          costUsd: 0,
        },
        NOW,
      ),
    ).toBeUndefined();
    expect(
      ok(planSummary(src, store, "src/config.ts", HAIKU)).status.state,
    ).toBe("missing");
  });

  it("keeps no source in the cache database, though the model echoes it", async () => {
    const cacheDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "epoch-summaries-db-"),
    );
    dirs.push(cacheDir);
    const cache = SqliteCacheStore.open(cacheDir);
    const { summarize } = await setup(cache);
    for (const subject of [
      "src/config.ts",
      "src/server.ts",
      "pkg:example.com/m/pkg/a",
      "dir:src",
    ])
      summarize(subject, "Prose.", HAIKU, true);
    expect(cache.stats().summaries).toEqual({ paid: 4, local: 0 });
    cache.close();
    const lines = new Set<string>();
    for (const text of Object.values(FILES))
      for (const l of sourceLines(text)) lines.add(l);
    const stored = normalizeLine(
      [CACHE_FILE, `${CACHE_FILE}-wal`]
        .map((f) => path.join(cacheDir, f))
        .filter((f) => fs.existsSync(f))
        .map((f) => fs.readFileSync(f).toString("latin1"))
        .join("\n"),
    );
    expect(lines.size).toBeGreaterThan(5);
    expect([...lines].filter((l) => stored.includes(l))).toEqual([]);
  });
});
