import childProcess from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { toPosix } from "./discover.js";
import {
  GIT_HARDENING,
  GitError,
  changedSince,
  readHeadCommit,
} from "./git.js";
import { FsReader } from "./reader.js";

const A = "a".repeat(40);
const B = "b".repeat(40);
const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0))
    fs.rmSync(d, { recursive: true, force: true });
});

function repo(files: Record<string, string>) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "epoch-git-"));
  dirs.push(dir);
  for (const [rel, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), text);
  }
  const root = toPosix(path.resolve(dir));
  return readHeadCommit(new FsReader(root), root);
}

describe("readHeadCommit (plain file reads, no git process)", () => {
  it("follows a branch ref to a loose ref or packed-refs", () => {
    expect(
      repo({
        ".git/HEAD": "ref: refs/heads/main\n",
        ".git/refs/heads/main": `${A}\n`,
      }),
    ).toBe(A);
    expect(
      repo({
        ".git/HEAD": "ref: refs/heads/main\n",
        ".git/packed-refs": `# pack-refs with: peeled\n${B} refs/heads/other\n${A} refs/heads/main\n`,
      }),
    ).toBe(A);
  });

  it("reads a detached HEAD", () => {
    expect(repo({ ".git/HEAD": `${B}\n` })).toBe(B);
  });

  it("returns null for non-repos, unborn branches, odd refs and gitdirs outside the root", () => {
    expect(repo({ "a.ts": "" })).toBeNull();
    expect(repo({ ".git/HEAD": "ref: refs/heads/main\n" })).toBeNull();
    expect(repo({ ".git/HEAD": "ref: refs/heads/../../../etc\n" })).toBeNull();
    expect(
      repo({ ".git": "gitdir: /somewhere/else/.git/worktrees/x\n" }),
    ).toBeNull();
  });
});

describe("changedSince (--since)", () => {
  const git = (cwd: string, ...args: string[]) =>
    childProcess.execFileSync(
      "git",
      ["-c", "user.email=t@example.com", "-c", "user.name=t", ...args],
      {
        cwd,
        encoding: "utf8",
      },
    );

  function twoCommitRepo() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "epoch-since-"));
    dirs.push(dir);
    fs.mkdirSync(path.join(dir, "app/src"), { recursive: true });
    fs.writeFileSync(path.join(dir, "app/src/a.ts"), "a");
    fs.writeFileSync(path.join(dir, "app/src/b.ts"), "b");
    fs.writeFileSync(path.join(dir, "root.ts"), "r");
    git(dir, "init", "-q");
    git(dir, "add", ".");
    git(dir, "commit", "-q", "-m", "one");
    const first = git(dir, "rev-parse", "HEAD").trim();
    fs.writeFileSync(path.join(dir, "app/src/a.ts"), "a2");
    fs.writeFileSync(path.join(dir, "root.ts"), "r2");
    fs.writeFileSync(path.join(dir, "app/src/c.ts"), "c");
    git(dir, "add", ".");
    git(dir, "commit", "-q", "-m", "two");
    return { dir, first };
  }

  it("lists files changed between two commits, relative to the analyzed root, with hardened git", () => {
    const { dir, first } = twoCommitRepo();
    const spy = vi.spyOn(childProcess, "execFileSync");
    expect(changedSince(dir, first).sort()).toEqual([
      "app/src/a.ts",
      "app/src/c.ts",
      "root.ts",
    ]);
    expect(changedSince(path.join(dir, "app"), first).sort()).toEqual([
      "src/a.ts",
      "src/c.ts",
    ]);
    const calls = spy.mock.calls.map(([cmd, args]) => [
      cmd,
      ...(args as string[]),
    ]);
    expect(calls.length).toBe(4);
    for (const call of calls)
      expect(call.slice(0, 1 + GIT_HARDENING.length)).toEqual([
        "git",
        ...GIT_HARDENING,
      ]);
    expect(calls[1]).toEqual([
      "git",
      ...GIT_HARDENING,
      "diff",
      "--name-only",
      "-z",
      "--relative",
      "--no-renames",
      "--no-ext-diff",
      "--no-textconv",
      first,
      "HEAD",
      "--",
    ]);
    const env = (spy.mock.calls[0]?.[2] as { env: Record<string, string> }).env;
    expect(env.GIT_OPTIONAL_LOCKS).toBe("0");
    spy.mockRestore();
  });

  it("rejects unknown commits and option-like input", () => {
    const { dir } = twoCommitRepo();
    expect(() => changedSince(dir, "no-such-commit")).toThrow(GitError);
    const spy = vi.spyOn(childProcess, "execFileSync");
    expect(() => changedSince(dir, "--output=/tmp/x")).toThrow(GitError);
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });
});
