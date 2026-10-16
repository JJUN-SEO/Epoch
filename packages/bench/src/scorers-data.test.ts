import childProcess from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { labelCandidates } from "./scorer-eval.js";
import { laterCommits, snapshotAt } from "./scorers-data.js";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0))
    fs.rmSync(d, { recursive: true, force: true });
});

const DAY = 86_400;
const START = 1_700_000_000;

function repo() {
  const dir = fs.realpathSync.native(
    fs.mkdtempSync(path.join(os.tmpdir(), "epoch-bench-planted-")),
  );
  dirs.push(dir);
  const git = (args: string[], day = 0) =>
    childProcess.execFileSync("git", args, {
      cwd: dir,
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: "t",
        GIT_AUTHOR_EMAIL: "t@example.com",
        GIT_COMMITTER_NAME: "t",
        GIT_COMMITTER_EMAIL: "t@example.com",
        GIT_AUTHOR_DATE: `${String(START + day * DAY)} +0000`,
        GIT_COMMITTER_DATE: `${String(START + day * DAY)} +0000`,
      },
    });
  const touch = (files: string[], day: number) => {
    for (const f of files) {
      fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true });
      fs.appendFileSync(
        path.join(dir, f),
        `export const x${String(day)} = 1;\n`,
      );
    }
    git(["add", "-A"]);
    git(["commit", "-q", "--no-gpg-sign", "-m", `day ${String(day)}`], day);
  };
  git(["init", "-q", "-b", "main"]);
  return { dir, git, touch };
}

describe(
  "snapshots and later commits (a planted future)",
  { timeout: 60_000 },
  () => {
    it("proposes only from history up to the snapshot, and labels with what came after", async () => {
      const r = repo();
      r.touch(["a.ts", "b.ts", "c.ts", "d.ts"], 0);
      for (const day of [10, 20, 30]) r.touch(["a.ts", "b.ts"], day);
      // After the snapshot (day 50): c and d start changing together, and a
      // is renamed, then changes with b under its new name.
      for (const day of [60, 70, 80]) r.touch(["c.ts", "d.ts"], day);
      fs.mkdirSync(path.join(r.dir, "lib"));
      r.git(["mv", "a.ts", "lib/a.ts"], 90);
      r.git(["commit", "-q", "--no-gpg-sign", "-m", "move"], 90);
      r.touch(["lib/a.ts", "b.ts"], 100);

      const snap = await snapshotAt(r.dir, START + 50 * DAY);
      expect(snap?.time).toBe(START + 30 * DAY);
      const pairs = snap?.candidates.map((c) => `${c.source}>${c.target}`);
      expect(pairs).toContain("a.ts>b.ts");
      expect(pairs).not.toContain("c.ts>d.ts");
      expect(
        snap?.candidates.find((c) => c.source === "a.ts")?.signals.cochange,
      ).toEqual({ together: 4, sourceCommits: 4, targetCommits: 4 });

      const later = laterCommits(
        r.dir,
        snap?.time ?? 0,
        START + 200 * DAY,
        snap?.nodeOf ?? new Map(),
      );
      expect(later).toEqual([
        ["c.ts", "d.ts"],
        ["c.ts", "d.ts"],
        ["c.ts", "d.ts"],
        ["a.ts"],
        ["a.ts", "b.ts"],
      ]);
      const labels = labelCandidates(snap?.candidates ?? [], later);
      expect(
        labels.labeled.find(
          (l) => l.candidate.source === "a.ts" && l.candidate.target === "b.ts",
        )?.y,
      ).toBe(1);

      // A model scorer, when asked for, scores the snapshot's own files.
      const seen: string[] = [];
      const scored = await snapshotAt(r.dir, START + 50 * DAY, {
        model: {
          backend: {
            id: "local:fake",
            provider: "a fake local model",
            destination: "http://127.0.0.1:11434",
            remote: false,
            maxOutputTokens: 10,
            judge: (prompt) => {
              seen.push(prompt.user);
              return Promise.resolve({
                verdict: { probability: 0.5, relation: "unclear", symbols: [] },
                usage: { inputTokens: 1, outputTokens: 1 },
              });
            },
          },
          maxPairs: 10,
          consent: false,
        },
      });
      expect(
        scored?.model?.scores.map((x) => `${x.source}>${x.target}`),
      ).toEqual(["a.ts>b.ts", "b.ts>a.ts"]);
      expect(seen[0]).toContain("export const x30 = 1;");
    });
  },
);
