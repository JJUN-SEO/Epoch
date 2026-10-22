import childProcess from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { gitCommitSets } from "./cochange.js";
import { MemoryCacheStore } from "./cache/memory-store.js";
import { toPosix } from "./discover.js";
import { GIT_HARDENING, type GitRunner } from "./git.js";
import { FsReader } from "./reader.js";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0))
    fs.rmSync(d, { recursive: true, force: true });
});

const DAY = 86_400;
const HEAD_TIME = 1_780_000_000;

function gitRepo() {
  const dir = toPosix(
    fs.realpathSync.native(
      fs.mkdtempSync(path.join(os.tmpdir(), "epoch-cochange-")),
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
  };
  return { dir, git, write, commit };
}

/** A runner that counts git processes. */
function counting(): { run: GitRunner; calls: () => number } {
  let n = 0;
  return {
    run: (args, cwd) => {
      n++;
      return childProcess.execFileSync("git", [...GIT_HARDENING, ...args], {
        cwd,
        encoding: "utf8",
      });
    },
    calls: () => n,
  };
}

describe("gitCommitSets", { timeout: 60_000 }, () => {
  it("lists each non-merge commit's files in the window, under their current names", () => {
    const r = gitRepo();
    r.write("a.ts", "1\n");
    r.write("old.ts", "1\n");
    r.commit("ancient", 400); // outside a 365-day window
    r.write("a.ts", "2\n");
    r.write("old.ts", "2\n");
    r.commit("together", 100);
    r.git(["mv", "old.ts", "new.ts"], HEAD_TIME - 50 * DAY);
    r.commit("rename", 50);
    r.git(["checkout", "-q", "-b", "side"]);
    r.write("b.ts", "1\n");
    r.commit("side", 20);
    r.git(["checkout", "-q", "main"]);
    r.git(
      ["merge", "-q", "--no-ff", "--no-gpg-sign", "-m", "merge", "side"],
      HEAD_TIME,
    );
    const sets = gitCommitSets(r.dir, new FsReader(r.dir), { days: 365 });
    expect(sets.status).toBe("usable");
    expect(sets.commits.map((c) => c.join(" ")).sort()).toEqual([
      "a.ts new.ts",
      "b.ts",
      "new.ts",
    ]);
  });

  it("caches the commit sets per HEAD, and reports a folder without git", () => {
    const r = gitRepo();
    r.write("a.ts", "1\n");
    r.write("b.ts", "1\n");
    r.commit("one", 10);
    const store = new MemoryCacheStore();
    const git = counting();
    const opts = { days: 365, run: git.run, store };
    const first = gitCommitSets(r.dir, new FsReader(r.dir), opts);
    const used = git.calls();
    expect(gitCommitSets(r.dir, new FsReader(r.dir), opts)).toEqual(first);
    expect(git.calls()).toBe(used);
    r.write("a.ts", "2\n");
    r.commit("two", 5);
    expect(
      gitCommitSets(r.dir, new FsReader(r.dir), opts).commits,
    ).toHaveLength(2);

    const plain = toPosix(
      fs.realpathSync.native(
        fs.mkdtempSync(path.join(os.tmpdir(), "epoch-cochange-")),
      ),
    );
    dirs.push(plain);
    expect(gitCommitSets(plain, new FsReader(plain), { days: 365 })).toEqual({
      status: "not-a-repo",
      commits: [],
    });
  });
});
