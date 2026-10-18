import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { checksums, installerNames } from "./checksums.mjs";

test("installer names come from installers.json, per OS", () => {
  assert.deepEqual(installerNames("linux"), [
    "Epoch-linux-x64.AppImage",
    "Epoch-linux-x64.deb",
  ]);
  assert.throws(() => installerNames("plan9"), /unknown OS/);
});

test("lines are in sha256sum's format, and a missing installer fails", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "epoch-sums-"));
  try {
    fs.writeFileSync(path.join(dir, "a.deb"), "hello");
    const hex = createHash("sha256").update("hello").digest("hex");
    assert.equal(checksums(dir, ["a.deb"]), `${hex}  a.deb\n`);
    assert.throws(
      () => checksums(dir, ["a.deb", "b.AppImage"]),
      /missing installer\(s\) .*: b\.AppImage/,
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
