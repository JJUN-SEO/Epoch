import childProcess from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { MemoryCacheStore } from "./cache/memory-store.js";
import { toPosix } from "./discover.js";
import { defaultRunner, type GitRunner } from "./git.js";
import { GitHistory } from "./history.js";
import { FsReader } from "./reader.js";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0))
    fs.rmSync(d, { recursive: true, force: true });
});

const DAY = 86_400;
const HEAD_TIME = 1_780_000_000;
const daysAgo = (d: Date | null) =>
  d === null ? null : Math.round((HEAD_TIME - d.getTime() / 1000) / DAY);

/** A temp repository driven by real git, with commit dates we choose. */
function gitRepo() {
  const dir = toPosix(
    fs.realpathSync.native(
      fs.mkdtempSync(path.join(os.tmpdir(), "epoch-history-")),
    ),
  );
  dirs.push(dir);
  const git = (args: string[], when = HEAD_TIME) =>
    childProcess.execFileSync("git", args, {
      cwd: dir,
      encoding: "utf8",
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: "t",
        GIT_AUTHOR_EMAIL: "t@example.com",
        GIT_COMMITTER_NAME: "t",
        GIT_COMMITTER_EMAIL: "t@example.com",
        GIT_AUTHOR_DATE: `${String(when)} +0000`,
        GIT_COMMITTER_DATE: `${String(when)} +0000`,
      },
    });
  git(["init", "-q", "-b", "main"]);
  const write = (rel: string, text: string) => {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), text);
  };
  const commit = (message: string, daysBeforeHead: number) => {
    git(["add", "-A"]);
    git(
      ["commit", "-q", "--no-gpg-sign", "-m", message],
      HEAD_TIME - daysBeforeHead * DAY,
    );
    return git(["rev-parse", "HEAD"]).trim();
  };
  const open = (opts: { run?: GitRunner; store?: MemoryCacheStore } = {}) =>
    GitHistory.open(dir, new FsReader(dir), { staleAfterDays: 90, ...opts });
  return { dir, git, write, commit, open };
}

// Each test drives real git (init, commits, clones): process spawns are slow
// on Windows runners, so these get more time than vitest's 5 s default.
describe("GitHistory", { timeout: 60_000 }, () => {
  it("reports a missing repository, too-short history and a shallow clone", () => {
    const plain = toPosix(
      fs.realpathSync.native(
        fs.mkdtempSync(path.join(os.tmpdir(), "epoch-plain-")),
      ),
    );
    dirs.push(plain);
    expect(
      GitHistory.open(plain, new FsReader(plain), {
        staleAfterDays: 90,
      }).status(),
    ).toEqual({
      usable: false,
      reason: "not-a-repo",
    });

    const r = gitRepo();
    r.write("a.ts", "1\n");
    r.commit("first", 30);
    r.write("a.ts", "2\n");
    r.commit("second", 0);
    expect(r.open().status()).toEqual({ usable: false, reason: "too-short" });
    expect(r.open().now()?.getTime()).toBe(HEAD_TIME * 1000);

    const old = gitRepo();
    old.write("a.ts", "1\n");
    old.commit("first", 400);
    old.write("a.ts", "2\n");
    old.commit("second", 0);
    expect(old.open().status()).toEqual({ usable: true });
    const shallow = toPosix(
      fs.realpathSync.native(
        fs.mkdtempSync(path.join(os.tmpdir(), "epoch-shallow-")),
      ),
    );
    dirs.push(shallow);
    childProcess.execFileSync("git", [
      "clone",
      "-q",
      "--depth",
      "1",
      `file://${old.dir}`,
      shallow,
    ]);
    expect(
      GitHistory.open(shallow, new FsReader(shallow), {
        staleAfterDays: 90,
      }).status(),
    ).toEqual({
      usable: false,
      reason: "shallow",
    });
  });

  it("finds when a flag key first appeared, scoped to the given files", async () => {
    const r = gitRepo();
    r.write("a.ts", "const x = 1;\n");
    r.write("b.ts", 'flag("beta");\n');
    r.commit("beta in b", 300);
    r.write("a.ts", 'flag("beta");\n');
    r.commit("beta in a", 200);
    r.write("a.ts", 'flag("beta"); // edited\n');
    r.commit("edit", 10);
    const h = r.open();
    expect(daysAgo(await h.firstIntroduced("beta", ["a.ts"]))).toBe(200);
    expect(daysAgo(await h.firstIntroduced("beta", ["a.ts", "b.ts"]))).toBe(
      300,
    );
    expect(await h.firstIntroduced("missing", ["a.ts"])).toBeNull();
    expect(await h.firstIntroduced("-S.*", ["a.ts"])).toBeNull(); // a fixed string, not an option or regex
  });

  it("blames line ranges at HEAD, ignoring whitespace-only and listed revisions", async () => {
    const r = gitRepo();
    r.write("a.ts", "one\ntwo\nthree\nfour\n");
    r.commit("base", 300);
    r.write("a.ts", "one\nTWO\nthree\nfour\n");
    r.commit("edit two", 150);
    r.write("a.ts", "one\nTWO\n  three\nfour\n");
    r.commit("whitespace", 100);
    r.write("a.ts", "ONE\nTWO\n  three\nfour\n");
    const reformat = r.commit("reformat", 20);
    let h = r.open();
    expect(daysAgo(await h.lastTouched("a.ts", 4, 4))).toBe(300);
    expect(daysAgo(await h.lastTouched("a.ts", 2, 3))).toBe(150); // -w skips the whitespace commit
    expect(daysAgo(await h.lastTouched("a.ts", 1, 1))).toBe(20);
    r.write(".git-blame-ignore-revs", `${reformat}\n`);
    r.commit("ignore the reformat", 5);
    h = r.open();
    expect(daysAgo(await h.lastTouched("a.ts", 1, 1))).toBe(300);
  });

  it("counts uncommitted lines as now and maps unchanged ones to their HEAD lines", async () => {
    const r = gitRepo();
    r.write("a.ts", "one\ntwo\nthree\n");
    r.commit("base", 300);
    r.write("a.ts", "one\ntwo\nthree\nfour\n");
    r.commit("add four", 0);
    r.write("a.ts", "new\none\ntwo\nthree\nfour\nmore\n"); // uncommitted edits
    r.write("fresh.ts", "x\n"); // untracked
    const h = r.open();
    expect(daysAgo(await h.lastTouched("a.ts", 1, 1))).toBe(0);
    expect(daysAgo(await h.lastTouched("a.ts", 2, 4))).toBe(300); // HEAD lines 1-3
    expect(daysAgo(await h.lastTouched("a.ts", 4, 6))).toBe(0);
    expect(daysAgo(await h.lastTouched("fresh.ts", 1, 1))).toBe(0);
    expect(daysAgo(await h.lastTouchedFile("a.ts"))).toBe(0); // modified
    expect(daysAgo(await h.lastTouchedFile("fresh.ts"))).toBe(0);
  });

  it("dates a whole file by its last commit", async () => {
    const r = gitRepo();
    r.write("a.ts", "1\n");
    r.write("b.ts", "1\n");
    r.commit("both", 300);
    r.write("b.ts", "2\n");
    r.commit("b", 120);
    r.write("c.ts", "1\n");
    r.commit("c", 0);
    const h = r.open();
    expect(daysAgo(await h.lastTouchedFile("a.ts"))).toBe(300);
    expect(daysAgo(await h.lastTouchedFile("b.ts"))).toBe(120);
  });

  it("caches answers per HEAD in the derived store", async () => {
    const r = gitRepo();
    r.write("a.ts", "1\n");
    r.commit("base", 300);
    r.write("b.ts", "1\n");
    r.commit("b", 0);
    const store = new MemoryCacheStore();
    const calls: string[][] = [];
    const run: GitRunner = (args, cwd) => {
      calls.push([...args]);
      return defaultRunner(args, cwd);
    };
    await r.open({ run, store }).lastTouchedFile("a.ts");
    const blamesBefore = calls.filter(
      (c) => c[0] === "log" && c.includes("a.ts"),
    ).length;
    await r.open({ run, store }).lastTouchedFile("a.ts");
    expect(
      calls.filter((c) => c[0] === "log" && c.includes("a.ts")).length,
    ).toBe(blamesBefore);
    r.write("c.ts", "1\n");
    r.commit("c", 0); // HEAD moved: recomputed
    await r.open({ run, store }).lastTouchedFile("a.ts");
    expect(
      calls.filter((c) => c[0] === "log" && c.includes("a.ts")).length,
    ).toBe(blamesBefore + 1);
  });
});
