import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { toPosix } from "./discover.js";
import { readHeadCommit } from "./git.js";
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
