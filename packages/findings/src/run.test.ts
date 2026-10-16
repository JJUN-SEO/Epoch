import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_EPOCH_CONFIG,
  EpochConfig,
  type ConstantCondition,
  type FlagUsage,
  type GitHistoryProvider,
  type Graph,
} from "@epoch-dev/core";
import { looksLikeDebugToggle } from "./dead-branch.js";
import type { FindingsFile, FindingsInput } from "./input.js";
import { runFindings } from "./run.js";

const hash = (t: string) => createHash("sha256").update(t).digest("hex");
const OLD = new Date("2020-01-01T00:00:00Z");
const NOW = new Date("2026-06-01T00:00:00Z");
const oldHistory: GitHistoryProvider = {
  status: () => ({ usable: true }),
  firstIntroduced: () => Promise.resolve(OLD),
  lastTouched: () => Promise.resolve(OLD),
  lastTouchedFile: () => Promise.resolve(OLD),
};

const graphOf = (files: readonly string[]): Graph => ({
  schemaVersion: 1,
  nodes: files.map((id) => ({
    id,
    kind: "file",
    language: "typescript",
    loc: 1,
    contentHash: "h",
    exports: [],
    externals: [],
    flags: [],
    metrics: { fanIn: 0, fanOut: 0 },
  })),
  edges: [],
  roots: [],
  findings: [],
  unresolved: [],
});

const condition = (
  line: number,
  extra: Partial<ConstantCondition> = {},
): ConstantCondition => ({
  name: "ENABLED",
  value: false,
  scope: "module",
  line,
  endLine: line + 2,
  deadBranch: "then",
  ...extra,
});

const usage = (line: number, extra: Partial<FlagUsage> = {}): FlagUsage => ({
  flagName: "beta",
  line,
  endLine: line,
  detection: "sdk-call",
  strength: "strong",
  ...extra,
});

function input(
  files: FindingsFile[],
  extra: Partial<FindingsInput> = {},
): FindingsInput {
  return {
    graph: graphOf(files.map((f) => f.path)),
    files,
    packages: new Map(),
    roots: files.map((f) => ({
      file: f.path,
      reason: "manifest",
      source: "test",
    })),
    packageDirs: [],
    frameworks: [],
    config: DEFAULT_EPOCH_CONFIG,
    history: oldHistory,
    now: NOW,
    hash,
    ...extra,
  };
}

const file = (
  path: string,
  facts: Partial<FindingsFile["facts"]> = {},
): FindingsFile => ({
  path,
  language: "typescript",
  isTest: false,
  facts: {
    flagUsages: [],
    constantConditions: [],
    isGenerated: false,
    ...facts,
  },
});

describe("runFindings", () => {
  it("keeps finding ids when lines move", async () => {
    const before = await runFindings(
      input([
        file("a.ts", {
          constantConditions: [condition(3), condition(9)],
          flagUsages: [usage(5)],
        }),
      ]),
    );
    const after = await runFindings(
      input([
        file("a.ts", {
          constantConditions: [condition(13), condition(30)],
          flagUsages: [usage(40)],
        }),
      ]),
    );
    expect(before.findings).toHaveLength(3);
    expect(after.findings.map((f) => f.id)).toEqual(
      before.findings.map((f) => f.id),
    );
  });

  it("never rates a stale flag High, whatever its usages", async () => {
    for (const strengths of [
      ["strong"],
      ["weak"],
      ["strong", "weak"],
      ["weak", "weak"],
    ] as const) {
      for (const detection of [
        "sdk-call",
        "wrapper-call",
        "env-read",
      ] as const) {
        const out = await runFindings(
          input([
            file("a.ts", {
              flagUsages: strengths.map((strength, i) =>
                usage(i + 1, { strength, detection }),
              ),
            }),
          ]),
        );
        const flags = out.findings.filter((f) => f.kind === "stale-flag");
        expect(flags).toHaveLength(1);
        expect(flags[0]?.confidence).not.toBe("high");
      }
    }
  });

  it("skips stale flags without usable history, and counts non-literal keys", async () => {
    const files = [
      file("a.ts", { flagUsages: [usage(1), usage(2, { flagName: null })] }),
    ];
    const { history: _history, ...withoutHistory } = input(files);
    const off = await runFindings(withoutHistory);
    expect(off.history).toBe("off");
    expect(off.findings.filter((f) => f.kind === "stale-flag")).toEqual([]);
    expect(off.unassessableFlags).toBe(1);
    const shallow = await runFindings(
      input(files, {
        history: {
          ...oldHistory,
          status: () => ({ usable: false, reason: "shallow" }),
        },
      }),
    );
    expect(shallow.history).toBe("shallow");
    expect(shallow.findings.filter((f) => f.kind === "stale-flag")).toEqual([]);
  });

  it("suppresses findings under findings.ignore, and skips generated files", async () => {
    const config = EpochConfig.parse({ findings: { ignore: ["legacy/**"] } });
    const out = await runFindings(
      input(
        [
          file("legacy/a.ts", { constantConditions: [condition(1)] }),
          file("gen.ts", {
            constantConditions: [condition(1)],
            isGenerated: true,
          }),
          file("b.ts", { constantConditions: [condition(1)] }),
        ],
        { config },
      ),
    );
    expect(out.findings.map((f) => f.subject.name)).toEqual(["b.ts"]);
  });

  it("caps an unreached file at Medium when a strong hint links it to a reached file", async () => {
    const files = ["main.ts", "lib.ts", "strong.ts", "weak.ts", "pair.ts"].map(
      (p) => file(p),
    );
    const hint = (source: string, target: string, confidence: number) => ({
      source,
      target,
      kind: "shared-string" as const,
      provenance: "shared-string" as const,
      confidence,
      evidence: ['both use the rare string "user.created"'],
    });
    const graph: Graph = {
      ...graphOf(files.map((f) => f.path)),
      edges: [
        {
          source: "main.ts",
          target: "lib.ts",
          kind: "import",
          provenance: "resolver",
          confidence: 1,
          evidence: [],
        },
        // A hint in either direction links the two files.
        hint("lib.ts", "strong.ts", 0.7),
        // Below the threshold: no cap.
        hint("weak.ts", "lib.ts", 0.4),
        // Links two unreached files: no cap.
        hint("pair.ts", "weak.ts", 0.9),
      ],
    };
    const out = await runFindings(
      input(files, {
        graph,
        roots: [{ file: "main.ts", reason: "manifest", source: "test" }],
        hintThreshold: 0.5,
      }),
    );
    const bySubject = new Map(out.findings.map((f) => [f.subject.name, f]));
    expect(bySubject.get("strong.ts")).toMatchObject({
      confidence: "medium",
      caps: ["strong-hint"],
    });
    expect(bySubject.get("strong.ts")?.caveats).toContain(
      'A likely relation links it to `lib.ts`, which an entry point reaches (shared strings, confidence 0.70: both use the rare string "user.created"), so it may be used in a way imports do not show.',
    );
    expect(bySubject.get("weak.ts")).toMatchObject({
      confidence: "high",
      caps: [],
    });
    expect(bySubject.get("pair.ts")).toMatchObject({
      confidence: "high",
      caps: [],
    });
  });

  it("sorts findings by kind, subject and id", async () => {
    const out = await runFindings(
      input(
        [
          file("z.ts", { constantConditions: [condition(1)] }),
          file("a.ts", {
            constantConditions: [condition(1)],
            flagUsages: [usage(4)],
          }),
          file("orphan.ts"),
        ],
        {
          roots: [
            { file: "a.ts", reason: "manifest", source: "test" },
            { file: "z.ts", reason: "manifest", source: "test" },
          ],
        },
      ),
    );
    expect(out.findings.map((f) => `${f.kind} ${f.subject.name}`)).toEqual([
      "dead-branch a.ts",
      "dead-branch z.ts",
      "stale-flag beta",
      "unreachable-file orphan.ts",
    ]);
  });
});

describe("looksLikeDebugToggle", () => {
  it("spots debug and compile-time toggles by word, in any case style", () => {
    for (const name of [
      "DEBUG",
      "isDebug",
      "debug_mode",
      "TRACE_SQL",
      "VERBOSE",
      "__DEV__",
      "TYPE_CHECKING",
      "kProfiling",
    ]) {
      expect(looksLikeDebugToggle(name), name).toBe(true);
    }
    for (const name of [
      "ENABLE_BETA",
      "debugger_url_x",
      "devices",
      "tracer",
      "USE_NEW_UI",
    ]) {
      expect(looksLikeDebugToggle(name), name).toBe(false);
    }
  });
});
