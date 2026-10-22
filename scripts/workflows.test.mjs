// Rules every GitHub Actions workflow follows (ADR-018). Third-party code in
// CI runs with the repository's token, so each action is pinned to a full
// commit, workflows start read-only, write access is granted only to the one
// job that needs it, and checkouts keep no credentials.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const dir = path.join(root, ".github/workflows");
const workflows = fs
  .readdirSync(dir)
  .filter((f) => f.endsWith(".yml"))
  .sort()
  .map((file) => {
    const text = fs.readFileSync(path.join(dir, file), "utf8");
    return { file, text, doc: parse(text) };
  });

/** The only write permissions any job may have: file, job, scope. */
const WRITES = new Set([
  "release.yml publish contents",
  "site.yml deploy pages",
  "site.yml deploy id-token",
]);

const steps = (doc) =>
  Object.entries(doc.jobs ?? {}).flatMap(([job, j]) =>
    (j.steps ?? []).map((step) => ({ job, step })),
  );

test("there are workflows to check", () => {
  assert.ok(workflows.some((w) => w.file === "ci.yml"));
});

for (const { file, text, doc } of workflows) {
  test(`${file}: every action is pinned to a commit, with its version noted`, () => {
    for (const line of text.split("\n")) {
      const m = /^\s*(?:-\s+)?uses:\s*(\S+)(.*)$/.exec(line);
      if (!m) continue;
      const [, ref, rest] = m;
      if (ref.startsWith("./")) continue;
      assert.match(ref, /^[\w.-]+\/[\w./-]+@[0-9a-f]{40}$/, line);
      assert.match(rest, /#\s*v\d/, `no version comment: ${line}`);
    }
  });

  test(`${file}: read-only by default; writes only where allowed`, () => {
    assert.deepEqual(doc.permissions, { contents: "read" });
    for (const [job, j] of Object.entries(doc.jobs ?? {})) {
      if (j.permissions === undefined) continue;
      assert.equal(typeof j.permissions, "object", `${job}: list scopes`);
      for (const [scope, level] of Object.entries(j.permissions)) {
        if (level === "write")
          assert.ok(
            WRITES.has(`${file} ${job} ${scope}`),
            `${file}: job ${job} may not write ${scope}`,
          );
      }
    }
  });

  test(`${file}: checkouts keep no credentials`, () => {
    for (const { job, step } of steps(doc)) {
      if (!String(step.uses ?? "").startsWith("actions/checkout@")) continue;
      assert.equal(
        step.with?.["persist-credentials"],
        false,
        `${file}: a checkout in ${job} keeps the token`,
      );
    }
  });
}
