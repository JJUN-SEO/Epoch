import assert from "node:assert/strict";
import { test } from "node:test";
import {
  appVersion,
  isReleaseVersion,
  tagProblem,
} from "./release-version.mjs";

test("a release version is MAJOR.MINOR.PATCH and nothing else", () => {
  for (const v of ["0.1.0", "1.2.3", "10.20.30"])
    assert.equal(isReleaseVersion(v), true, v);
  for (const v of ["1.2", "1.2.3-rc.1", "1.2.3+build", "01.2.3", "v1.2.3", ""])
    assert.equal(isReleaseVersion(v), false, v);
});

test("the tag must be v plus the package version", () => {
  assert.equal(tagProblem("v0.1.0", "0.1.0"), undefined);
  assert.match(tagProblem("v0.1.1", "0.1.0"), /expected "v0\.1\.0"/);
  assert.match(tagProblem("0.1.0", "0.1.0"), /expected "v0\.1\.0"/);
  assert.match(
    tagProblem("v1.2.3-rc.1", "1.2.3-rc.1"),
    /not MAJOR\.MINOR\.PATCH/,
  );
});

test("the version is read from the app's package.json", () => {
  assert.equal(typeof appVersion(), "string");
});
