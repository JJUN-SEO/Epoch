import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  CONFIDENCE_LABELS,
  FINDING_KIND_LABELS,
  RUBRIC_CAPS,
} from "@epoch-dev/core";

/*
 * Findings are candidates, never verdicts (CLAUDE.md principle 6, ADR-007).
 * This fails the build if any source that writes user-facing finding text
 * (the UI, the CLI report, the detectors' wording, the shared labels)
 * states a finding as certain.
 */

const PACKAGES = fileURLToPath(new URL("../../", import.meta.url));
const ROOT = path.dirname(PACKAGES);

/** Phrases that state something is dead or unused as a fact. */
const CERTAIN =
  /\b(?:is dead|are dead|dead code|never used|is unused|are unused|safe to delete|must (?:be )?removed?|definitely|certainly)\b/i;

function sources(dir: string): string[] {
  return fs
    .readdirSync(dir, { recursive: true, encoding: "utf8" })
    .filter(
      (f) =>
        /\.tsx?$/.test(f) && !/\.test\.tsx?$/.test(f) && !f.endsWith(".d.ts"),
    )
    .map((f) => path.join(dir, f));
}

const FILES = [
  ...sources(path.join(PACKAGES, "ui/src")),
  path.join(PACKAGES, "cli/src/findings.ts"),
  path.join(PACKAGES, "cli/src/run.ts"),
  path.join(PACKAGES, "core/src/findings.ts"),
  path.join(PACKAGES, "findings/src/dead-branch.ts"),
  path.join(PACKAGES, "findings/src/stale-flag.ts"),
  path.join(PACKAGES, "findings/src/unreachable.ts"),
  // The static site and the README describe findings to visitors.
  ...sources(path.join(ROOT, "apps/site/src")),
  path.join(ROOT, "apps/site/index.html"),
  path.join(ROOT, "README.md"),
];

describe("finding wording", () => {
  it("never states a finding as certain", () => {
    const hits: string[] = [];
    for (const file of FILES) {
      const lines = fs.readFileSync(file, "utf8").split("\n");
      lines.forEach((line, i) => {
        if (CERTAIN.test(line)) {
          hits.push(
            `${path.relative(PACKAGES, file)}:${String(i + 1)}: ${line.trim()}`,
          );
        }
      });
    }
    expect(hits).toEqual([]);
  });

  it("names every kind with a hedge, and no level as certain", () => {
    for (const label of Object.values(FINDING_KIND_LABELS)) {
      expect(label).toMatch(/\b(?:likely|possibly)\b/i);
      expect(label).not.toMatch(/\bdead\b/i);
    }
    for (const label of Object.values(CONFIDENCE_LABELS)) {
      expect(label).not.toMatch(/\b(?:dead|certain|sure|confirmed)\b/i);
    }
    for (const cap of Object.values(RUBRIC_CAPS)) {
      expect(cap.reason).not.toMatch(CERTAIN);
    }
  });
});
