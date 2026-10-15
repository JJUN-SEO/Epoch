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

/** Starts watching and collects updates and statuses. */
async function watched(dir: string) {
  const cache = new MemoryCacheStore();
  const initial = await analyze(dir, { cache, history: false });
  const updates: AnalyzeResult[] = [];
  const statuses: WatchStatus[] = [];
  const w = await watchProject(initial, {
    analyze: { cache, history: false },
    onUpdate: (r) => updates.push(r),
    onStatus: (s) => statuses.push(s),
    quietMs: 100,
    maxMs: 1000,
    headPollMs: 100,
  });
  watchers.push(w);
  return { initial, updates, statuses };
}

/** Waits until the latest update's graph equals a fresh analysis. */
async function settles(dir: string, updates: AnalyzeResult[]): Promise<void> {
  const fresh = serializeCanonical(
    (await analyze(dir, { history: false })).graph,
  );
  await vi.waitFor(
    () => {
      const last = updates.at(-1);
      expect(last && serializeCanonical(last.graph)).toBe(fresh);
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
    expect(statuses).toEqual([{ state: "watching" }]);

    write(dir, "src/c.ts", 'import { a } from "./a";\nexport const c = a;\n');
    await settles(dir, updates);
    expect(updates.at(-1)?.graph.nodes.map((n) => n.id)).toContain("src/c.ts");

    fs.rmSync(path.join(dir, "src/b.ts"));
    await settles(dir, updates);
    expect(updates.at(-1)?.graph.unresolved).toMatchObject([
      { from: "src/a.ts", specifier: "./b", reason: "not-found" },
    ]);
    expect(statuses.at(-1)).toEqual({ state: "watching" });
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
    const { updates } = await watched(dir);

    git(dir, "checkout", "-q", "feature");
    await settles(dir, updates);
    expect(updates.at(-1)?.graph.nodes.map((n) => n.id)).toContain("src/d.ts");

    git(dir, "checkout", "-q", "main");
    await settles(dir, updates);
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
    const { updates } = await watched(dir);
    write(dir, "node_modules/x/other.js", "");
    write(dir, "dist/y.js", "");
    write(dir, "src/.a.ts.swp", "");
    write(dir, "src/a.ts~", "");
    // A real change afterwards proves events flow; only it causes an update.
    await new Promise((r) => setTimeout(r, 500));
    expect(updates).toHaveLength(0);
    write(dir, "src/e.ts", "export const e = 1;\n");
    await settles(dir, updates);
    expect(updates).toHaveLength(1);
  }, 40_000);
});
