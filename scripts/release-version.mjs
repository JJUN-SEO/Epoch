// The version Epoch is released as: packages/app/package.json's "version",
// the only place it is written (electron-builder copies it into every
// installer and the app reads it back with app.getVersion()).
//
// Usage: node scripts/release-version.mjs print
//        node scripts/release-version.mjs check <tag>
// `check` fails unless the tag is "v" + that version, and the version is a
// plain MAJOR.MINOR.PATCH (no pre-release or build suffix), which is all the
// update check understands (ADR-018).
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

/** MAJOR.MINOR.PATCH with no leading zeros, as in semver's core version. */
const VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

export function isReleaseVersion(version) {
  return VERSION.test(version);
}

/** Why `tag` cannot release `version`, or undefined when it can. */
export function tagProblem(tag, version) {
  if (!isReleaseVersion(version))
    return `package version ${JSON.stringify(version)} is not MAJOR.MINOR.PATCH`;
  if (tag !== `v${version}`)
    return `tag ${JSON.stringify(tag)} does not match the package version: expected "v${version}"`;
  return undefined;
}

export function appVersion() {
  const pkg = JSON.parse(
    fs.readFileSync(path.join(root, "packages/app/package.json"), "utf8"),
  );
  return pkg.version;
}

function main([command, tag]) {
  if (command === "print") {
    process.stdout.write(`${appVersion()}\n`);
    return 0;
  }
  if (command === "check" && tag !== undefined) {
    const problem = tagProblem(tag, appVersion());
    if (problem === undefined) return 0;
    process.stderr.write(`release-version: ${problem}\n`);
    return 1;
  }
  process.stderr.write("Usage: release-version.mjs print | check <tag>\n");
  return 1;
}

if (
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
  process.exitCode = main(process.argv.slice(2));
