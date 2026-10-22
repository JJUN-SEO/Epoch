import childProcess from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { gitChurn, parseChurnLog } from "./churn.js";
import { toPosix } from "./discover.js";
import { GIT_HARDENING, GitError, type GitRunner } from "./git.js";
import { FsReader } from "./reader.js";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0))
    fs.rmSync(d, { recursive: true, force: true });
});

const DAY = 86_400;
const HEAD_TIME = 1_780_000_000; // a fixed "now" for HEAD

/** A temp repository driven by real git, with commit dates we choose. */
function gitRepo() {
  const dir = toPosix(
    fs.realpathSync.native(
      fs.mkdtempSync(path.join(os.tmpdir(), "epoch-churn-")),
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

const counts = (c: ReturnType<typeof gitChurn>) =>
  Object.fromEntries([...c.commits].map(([p, s]) => [p, s.size]));

describe("gitChurn", () => {
  it("counts commits in the 90 days before HEAD, following renames and skipping merges", () => {
    const r = gitRepo();
    r.write("old.ts", "1\n");
    r.commit("ancient", 200); // outside the window
    r.write("old.ts", "2\n");
    r.commit("in window", 60);
    r.git(["mv", "old.ts", "new.ts"], HEAD_TIME - 50 * DAY);
    r.commit("rename", 50);
    r.git(["checkout", "-q", "-b", "side"]);
    r.write("side.ts", "s\n");
    r.commit("side work", 40);
    r.git(["checkout", "-q", "main"]);
    r.write("new.ts", "3\n");
    r.commit("edit", 30);
    r.git(["merge", "-q", "--no-edit", "--no-gpg-sign", "side"], HEAD_TIME);

    const churn = gitChurn(r.dir, new FsReader(r.dir));
    expect(churn.status).toMatchObject({ usable: true, shallow: false });
    // new.ts: "in window" (as old.ts), "rename", "edit"; not "ancient", not the merge.
    expect(counts(churn)).toEqual({ "new.ts": 3, "side.ts": 1 });
    if (churn.status.usable) {
      expect(churn.status.until - churn.status.since).toBe(90 * DAY);
    }
  });

  it("flags a shallow clone", () => {
    const r = gitRepo();
    r.write("a.ts", "1\n");
    r.commit("one", 10);
    r.write("a.ts", "2\n");
    r.commit("two", 5);
    const clone = toPosix(
      fs.realpathSync.native(
        fs.mkdtempSync(path.join(os.tmpdir(), "epoch-churn-clone-")),
      ),
    );
    dirs.push(clone);
    childProcess.execFileSync("git", [
      "clone",
      "-q",
      "--depth",
      "1",
      pathToFileURL(r.dir).href,
      clone,
    ]);
    const churn = gitChurn(clone, new FsReader(clone));
    expect(churn.status).toMatchObject({ usable: true, shallow: true });
    expect(counts(churn)).toEqual({ "a.ts": 1 });
  });

  it("reports folders that are not repositories, and git failures, without throwing", () => {
    const plain = fs.mkdtempSync(path.join(os.tmpdir(), "epoch-churn-plain-"));
    dirs.push(plain);
    const root = toPosix(plain);
    expect(gitChurn(root, new FsReader(root)).status).toEqual({
      usable: false,
      reason: "not-a-repo",
    });
    const r = gitRepo();
    r.write("a.ts", "1\n");
    r.commit("one", 1);
    const failing: GitRunner = () => {
      throw new GitError("git is not installed");
    };
    expect(gitChurn(r.dir, new FsReader(r.dir), failing).status).toEqual({
      usable: false,
      reason: "git-unavailable",
    });
  });

  it("runs only hardened, read-only log commands", () => {
    const r = gitRepo();
    r.write("a.ts", "1\n");
    r.commit("one", 1);
    const calls: string[][] = [];
    const recording: GitRunner = (args) => {
      calls.push([...args]);
      return args.includes("-1") ? `${String(HEAD_TIME)}\n` : "";
    };
    gitChurn(r.dir, new FsReader(r.dir), recording);
    expect(calls.map((c) => c[0])).toEqual(["log", "log"]);
    expect(calls[1]).toEqual(
      expect.arrayContaining([
        "--no-merges",
        "--no-show-signature",
        "--no-ext-diff",
        "--no-textconv",
        "-z",
      ]),
    );
    expect(GIT_HARDENING).toContain("log.showSignature=false");
  });
});

describe("parseChurnLog", () => {
  it("credits a chain of renames to the current name", () => {
    const log = [
      "\u0001c3",
      "\nR100",
      "b.ts",
      "c.ts",
      "\u0001c2",
      "\nR090",
      "a.ts",
      "b.ts",
      "\u0001c1",
      "\nM",
      "a.ts",
      "",
    ].join("\0");
    expect(
      Object.fromEntries([...parseChurnLog(log)].map(([p, s]) => [p, [...s]])),
    ).toEqual({ "c.ts": ["c3", "c2", "c1"] });
  });
});
