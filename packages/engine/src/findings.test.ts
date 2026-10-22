import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type {
  Finding,
  GitHistoryProvider,
  RelationScorer,
} from "@epoch-dev/core";
import { analyze } from "./analyze.js";

/**
 * The findings fixtures (PLAN.md M5): every case under
 * fixtures/<language>/findings/<case>/ is a mini repo with an expected.json.
 * Git history comes from a fake GitHistoryProvider described in case.json,
 * so each rubric cap is tested without a real repository. Hint edges come
 * only to cases whose case.json sets hints.probability: a fixed scorer gives
 * every candidate that probability, so the expectations never depend on the
 * heuristic's fitted coefficients. Findings are
 * compared on kind, subject, confidence, caps and locations; every finding
 * must also carry evidence, at least one caveat, and soft wording.
 */
const FIXTURES = fileURLToPath(new URL("../../../fixtures/", import.meta.url));
const REQUIRED_CASES: Readonly<Record<string, number>> = {
  typescript: 36,
  python: 12,
  go: 10,
};

interface FakeHistory {
  readonly status: "usable" | "shallow" | "not-a-repo" | "too-short";
  readonly now: string;
  readonly introduced?: Readonly<Record<string, string>>;
  /** "file" or "file:startLine" -> date. */
  readonly touched?: Readonly<Record<string, string>>;
}

interface Expected {
  readonly findings: readonly Pick<
    Finding,
    "kind" | "subject" | "confidence" | "caps" | "locations"
  >[];
  readonly unassessableFlags: number;
}

const OLD = new Date("2024-01-01T00:00:00Z");
const DEFAULT_HISTORY: FakeHistory = { status: "usable", now: "2026-06-01" };

/** A GitHistoryProvider answering from case.json: anything unlisted is old. */
function fakeHistory(h: FakeHistory): GitHistoryProvider {
  const date = (s: string | undefined) =>
    s === undefined ? OLD : new Date(`${s}T00:00:00Z`);
  return {
    status: () =>
      h.status === "usable"
        ? { usable: true }
        : { usable: false, reason: h.status },
    firstIntroduced: (flag) => Promise.resolve(date(h.introduced?.[flag])),
    lastTouched: (file, start) =>
      Promise.resolve(
        date(h.touched?.[`${file}:${String(start)}`] ?? h.touched?.[file]),
      ),
    lastTouchedFile: (file) => Promise.resolve(date(h.touched?.[file])),
  };
}

/** A scorer that gives every candidate the same probability. */
function fixedScorer(probability: number): RelationScorer {
  return {
    scoreRelations: (candidates) =>
      Promise.resolve(
        candidates.map((c) => ({
          source: c.source,
          target: c.target,
          probability,
          rationale: "",
        })),
      ),
    classifyFiles: () => Promise.resolve([]),
  };
}

interface Case {
  readonly language: string;
  readonly name: string;
  readonly dir: string;
  readonly history: FakeHistory;
  readonly hints?: { readonly probability: number };
}

function listCases(): Case[] {
  const out: Case[] = [];
  for (const language of fs.readdirSync(FIXTURES).sort()) {
    const root = path.join(FIXTURES, language, "findings");
    if (!fs.existsSync(root)) continue;
    for (const name of fs.readdirSync(root).sort()) {
      const dir = path.join(root, name);
      const meta = JSON.parse(
        fs.readFileSync(path.join(dir, "case.json"), "utf8"),
      ) as { history?: FakeHistory; hints?: { probability: number } };
      out.push({
        language,
        name,
        dir,
        history: meta.history ?? DEFAULT_HISTORY,
        ...(meta.hints ? { hints: meta.hints } : {}),
      });
    }
  }
  return out;
}

const cases = listCases();

/** Words that state a finding as certain (CLAUDE.md principle 6). */
const CERTAIN =
  /\b(?:is dead|are dead|dead code|never used|is unused|are unused|safe to delete|must (?:be )?remove)/i;
const SOFT = /\b(?:likely|possibly|may|might|candidate|stale|looks)\b/i;

describe("findings fixtures", () => {
  it("contains every required case", () => {
    for (const [language, count] of Object.entries(REQUIRED_CASES)) {
      expect(cases.filter((c) => c.language === language)).toHaveLength(count);
    }
  });

  for (const c of cases) {
    it(`${c.language}/${c.name}`, async () => {
      const expected = JSON.parse(
        fs.readFileSync(path.join(c.dir, "expected.json"), "utf8"),
      ) as Expected;
      const { graph, meta } = await analyze(c.dir, {
        history: false,
        findings: {
          history: fakeHistory(c.history),
          now: new Date(`${c.history.now}T00:00:00Z`),
        },
        hints: c.hints
          ? {
              scorer: {
                id: "fixed",
                scorer: fixedScorer(c.hints.probability),
                byModel: false,
              },
            }
          : false,
      });
      expect(
        graph.findings.map((f) => ({
          kind: f.kind,
          subject: f.subject,
          confidence: f.confidence,
          caps: f.caps,
          locations: f.locations,
        })),
      ).toEqual(expected.findings);
      expect(meta.findings.unassessableFlags).toBe(expected.unassessableFlags);
      for (const f of graph.findings) {
        expect(f.evidence.length, `evidence of ${f.id}`).toBeGreaterThan(0);
        expect(f.caveats.length, `caveats of ${f.id}`).toBeGreaterThan(0);
        if (f.kind === "stale-flag") expect(f.confidence).not.toBe("high");
        const text = [f.suggestedAction, ...f.evidence, ...f.caveats].join(
          "\n",
        );
        expect(text).not.toMatch(CERTAIN);
        expect(f.suggestedAction).toMatch(SOFT);
      }
    });
  }
});
