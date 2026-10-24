import childProcess from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { serializeCanonical, type WatchStatus } from "@epoch-dev/core";
import { analyze, type AnalyzeResult } from "./analyze.js";
import { MemoryCacheStore } from "./cache/memory-store.js";
import { toPosix } from "./discover.js";
import {
  Debouncer,
  isEditorNoise,
  watchProject,
  type ProjectWatcher,
} from "./watch.js";

describe("Debouncer", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("flushes a batch once events stop for the quiet period", () => {
    vi.useFakeTimers();
    const batches: string[][] = [];
    const d = new Debouncer(300, 2000, (b) => batches.push([...b].sort()));
    d.add("a");
    vi.advanceTimersByTime(200);
    d.add("b");
    d.add("a");
    vi.advanceTimersByTime(299);
    expect(batches).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(batches).toEqual([["a", "b"]]);
    vi.advanceTimersByTime(5000);
    expect(batches).toHaveLength(1);
  });

  it("flushes a steady stream at the maximum wait", () => {
    vi.useFakeTimers();
    const batches: number[] = [];
    const d = new Debouncer(300, 2000, (b) => batches.push(b.size));
    for (let t = 0; t < 2500; t += 100) {
      d.add(`f${String(t)}`);
      vi.advanceTimersByTime(100);
    }
    expect(batches[0]).toBe(20); // the first 20 events, at 2 s
    vi.advanceTimersByTime(300);
    expect(batches).toEqual([20, 5]);
  });

  it("drops pending paths when disposed", () => {
    vi.useFakeTimers();
    const flush = vi.fn();
    const d = new Debouncer(300, 2000, flush);
    d.add("a");
    d.dispose();
    vi.advanceTimersByTime(5000);
    expect(flush).not.toHaveBeenCalled();
  });
});

describe("isEditorNoise", () => {
  it("recognizes swap, backup, lock and safe-write files", () => {
    for (const n of [
      ".a.ts.swp",
      ".a.ts.swx",
      "a.ts~",
      ".#a.ts",
      "4913",
      "a.ts___jb_tmp___",
      "a.ts___jb_old___",
      ".DS_Store",
    ]) {
      expect(isEditorNoise(n), n).toBe(true);
    }
    for (const n of ["a.ts", "swap.ts", "main.go", "tmp"]) {
      expect(isEditorNoise(n), n).toBe(false);
    }
  });
});

/* ---------- with real file system events ---------- */

const dirs: string[] = [];
const watchers: ProjectWatcher[] = [];
afterEach(async () => {
  for (const w of watchers.splice(0)) await w.close();
  for (const d of dirs.splice(0))
    fs.rmSync(d, { recursive: true, force: true });
});

function project(files: Record<string, string>): string {
  const dir = toPosix(
    fs.realpathSync.native(
      fs.mkdtempSync(path.join(os.tmpdir(), "epoch-watch-")),
    ),
  );
  dirs.push(dir);
  for (const [rel, text] of Object.entries(files)) write(dir, rel, text);
  return dir;
}

function write(dir: string, rel: string, text: string): void {
  fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
  fs.writeFileSync(path.join(dir, rel), text);
}

const git = (cwd: string, ...args: string[]) =>
  childProcess.execFileSync(
    "git",
    [
      "-c",
      "user.email=t@example.com",
      "-c",
      "user.name=t",
      "-c",
      "commit.gpgsign=false",
      ...args,
    ],
    { cwd, stdio: "pipe" },
  );

/**
 * Starts watching, collects updates, their batches and statuses, and returns
 * once file events reach the watcher. On macOS, fs.watch on a directory is
 * one FSEvents stream that libuv recreates on its own thread, "since now",
 * for each new watch, so a change made right after chokidar's ready can be
 * lost (CI run 36). A file nothing analyzes is touched until an update shows.
 */
async function watched(dir: string) {
  const cache = new MemoryCacheStore();
  const initial = await analyze(dir, { cache, history: false });
  const updates: AnalyzeResult[] = [];
  const batches: ReadonlySet<string>[] = [];
  const statuses: WatchStatus[] = [];
  const w = await watchProject(initial, {
    analyze: { cache, history: false },
    onUpdate: (r, changed) => {
      updates.push(r);
      batches.push(changed);
    },
    onStatus: (s) => statuses.push(s),
    quietMs: 100,
    maxMs: 1000,
    headPollMs: 100,
  });
  watchers.push(w);
  expect(statuses).toEqual([{ state: "watching" }]);
  let pokes = 0;
  await vi.waitFor(
    () => {
      if (updates.length > 0) return;
      write(dir, "probe.txt", String(++pokes));
      throw new Error("no file event reached the watcher yet");
    },
    { timeout: 15_000, interval: 250 },
  );
  return { initial, updates, batches, statuses, watcher: w, cache };
}

/** Waits until the latest update's graph equals a fresh analysis. */
async function settles(
  dir: string,
  updates: AnalyzeResult[],
  statuses: WatchStatus[],
): Promise<void> {
  const fresh = serializeCanonical(
    (await analyze(dir, { history: false })).graph,
  );
  await vi.waitFor(
    () => {
      const last = updates.at(-1);
      expect(
        last && serializeCanonical(last.graph),
        `watcher statuses: ${JSON.stringify(statuses)}`,
      ).toBe(fresh);
    },
    { timeout: 15_000, interval: 50 },
  );
}

const FILES = {
  "src/a.ts": 'import { b } from "./b";\nexport const a = b;\n',
  "src/b.ts": "export const b = 1;\n",
};

describe("watchProject", () => {
  it("re-analyzes after an edit, a new file and a deletion", async () => {
    const dir = project(FILES);
    const { updates, statuses } = await watched(dir);

    write(dir, "src/c.ts", 'import { a } from "./a";\nexport const c = a;\n');
    await settles(dir, updates, statuses);
    expect(updates.at(-1)?.graph.nodes.map((n) => n.id)).toContain("src/c.ts");

    fs.rmSync(path.join(dir, "src/b.ts"));
    await settles(dir, updates, statuses);
    expect(updates.at(-1)?.graph.unresolved).toMatchObject([
      { from: "src/a.ts", specifier: "./b", reason: "not-found" },
    ]);
    expect(statuses.at(-1)).toEqual({ state: "watching" });
  }, 40_000);

  it("re-analyzes with new options at once, and keeps them for later changes", async () => {
    const dir = project(FILES);
    const { updates, watcher, cache } = await watched(dir);
    const embedded: string[] = [];
    const embedder = {
      modelId: "stand-in",
      embed: (texts: string[]) => {
        embedded.push(...texts);
        return Promise.resolve(texts.map(() => Float32Array.of(1, 0)));
      },
    };
    const before = updates.length;
    await watcher.reconfigure({
      cache,
      history: false,
      hints: { embeddings: { embedder } },
    });
    expect(updates.length).toBe(before + 1);
    expect(updates.at(-1)?.meta.hints.embeddings).toMatchObject({
      status: "ready",
      model: "stand-in",
    });
    expect(embedded).toHaveLength(2);

    write(dir, "src/b.ts", "export const b = 2;\n");
    await vi.waitFor(
      () => {
        expect(embedded).toHaveLength(3);
      },
      { timeout: 15_000, interval: 50 },
    );
    expect(updates.at(-1)?.meta.hints.embeddings.status).toBe("ready");
  }, 40_000);

  it("ends equal to a fresh analysis after a branch switch", async () => {
    const dir = project(FILES);
    git(dir, "init", "-q", "-b", "main");
    git(dir, "add", "-A");
    git(dir, "commit", "-q", "-m", "one");
    git(dir, "checkout", "-q", "-b", "feature");
    write(dir, "src/b.ts", 'import { d } from "./d";\nexport const b = d;\n');
    write(dir, "src/d.ts", "export const d = 2;\n");
    git(dir, "add", "-A");
    git(dir, "commit", "-q", "-m", "two");
    git(dir, "checkout", "-q", "main");
    const { updates, statuses } = await watched(dir);

    git(dir, "checkout", "-q", "feature");
    await settles(dir, updates, statuses);
    expect(updates.at(-1)?.graph.nodes.map((n) => n.id)).toContain("src/d.ts");

    git(dir, "checkout", "-q", "main");
    await settles(dir, updates, statuses);
    expect(updates.at(-1)?.graph.nodes.map((n) => n.id)).not.toContain(
      "src/d.ts",
    );
  }, 60_000);

  it("ignores node_modules, skipped directories and editor noise", async () => {
    const dir = project({
      ...FILES,
      "node_modules/x/index.js": "",
      "dist/x.js": "",
    });
    const { updates, batches, statuses } = await watched(dir);
    const noise = [
      "node_modules/x/other.js",
      "dist/y.js",
      "src/.a.ts.swp", // chokidar's atomic mode drops these two itself
      "src/a.ts~",
      "src/.#a.ts", // these two only isEditorNoise catches
      "src/a.ts___jb_tmp___",
    ];
    for (const rel of noise) write(dir, rel, "");
    // Give noise events time to arrive; a real change afterwards proves
    // events flow. No batch may ever name a noise path.
    await new Promise((r) => setTimeout(r, 500));
    write(dir, "src/e.ts", "export const e = 1;\n");
    await settles(dir, updates, statuses);
    const seen = batches.flatMap((b) => [...b]);
    expect(seen).toContain("src/e.ts");
    expect(seen.filter((p) => noise.includes(p))).toEqual([]);
  }, 40_000);

  it("re-analyzes when a coverage report is written, watching only the report in its folder", async () => {
    const dir = project(FILES);
    const { updates, batches } = await watched(dir);
    // A test run writes its HTML report and its data files into coverage/.
    write(dir, "coverage/lcov-report/index.html", "<html></html>");
    write(dir, "coverage/lcov.info", "SF:src/b.ts\nDA:1,1\nend_of_record\n");
    await vi.waitFor(
      () => {
        expect(updates.at(-1)?.meta.coverage.reports).toMatchObject([
          { source: "coverage/lcov.info", files: 1 },
        ]);
      },
      { timeout: 15_000, interval: 50 },
    );
    const seen = batches.flatMap((b) => [...b]);
    expect(seen).not.toContain("coverage/lcov-report/index.html");
  }, 40_000);

  it("watches a chosen report in a folder Discover skips", async () => {
    const dir = project({
      ...FILES,
      "build/reports/unit.lcov": "SF:src/b.ts\nDA:1,0\nend_of_record\n",
    });
    const { updates, watcher, cache } = await watched(dir);
    const coverageOfB = () =>
      updates.at(-1)?.graph.nodes.find((n) => n.id === "src/b.ts")?.metrics
        .coverage;
    await watcher.reconfigure({
      cache,
      history: false,
      coverageReport: "build/reports/unit.lcov",
    });
    expect(coverageOfB()).toBe(0);
    // chokidar sets the new watch up asynchronously: rewrite until it sees one.
    await vi.waitFor(
      () => {
        if (coverageOfB() === 1) return;
        write(
          dir,
          "build/reports/unit.lcov",
          "SF:src/b.ts\nDA:1,1\nend_of_record\n",
        );
        throw new Error("the rewritten report has not been read yet");
      },
      { timeout: 15_000, interval: 250 },
    );
  }, 40_000);
});
