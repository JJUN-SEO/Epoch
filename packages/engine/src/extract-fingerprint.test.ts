import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { Tree } from "web-tree-sitter";
import {
  canonicalJson,
  type AdapterRegistration,
  type ExtractorConfig,
} from "@epoch-dev/core";
import { DEFAULT_FLAG_PATTERNS } from "@epoch-dev/findings";
import { goRegistration } from "@epoch-dev/adapter-go";
import { pythonRegistration } from "@epoch-dev/adapter-python";
import { typescriptRegistration } from "@epoch-dev/adapter-typescript";
import { Parsers } from "./parse.js";

/**
 * Cache-poisoning guard (PLAN.md M2 pitfall, ADR-004): cached FileFacts are
 * keyed by the adapter version, so any change to what `extract` produces
 * must come with a version bump. This fingerprints each adapter's extract
 * output over every fixture file of its language; when it changes, bump the
 * adapter version and record the new fingerprint here in the same commit.
 * The extractor config turns on every flag detection, so flag extraction is
 * covered too.
 */
const CONFIG: ExtractorConfig = {
  flagPatterns: [...DEFAULT_FLAG_PATTERNS],
  wrapperFunctions: ["featureEnabled", "feature_enabled", "FeatureEnabled"],
  envPrefixes: ["FEATURE_", "ENABLE_"],
};
const ADAPTERS: readonly {
  readonly registration: AdapterRegistration<Tree>;
  readonly fixtures: string;
  readonly grammars: readonly string[];
  readonly minFiles: number;
  readonly fingerprints: Readonly<Record<string, string>>;
}[] = [
  {
    registration: typescriptRegistration,
    fixtures: "typescript",
    grammars: ["typescript", "tsx", "javascript"],
    minFiles: 40,
    fingerprints: {
      "2": "7b4596afcf409ec576fad84df17053c121e887132cd73fb53b93dbf03909d17c",
      "3": "96f756fc7ab66755421042464d1f368f10c85b7867149da9c4717af684dbc240",
      "4": "4401ee4744eca6534f4484d35cc090db018b84574fdb72609ea59b001238640e",
      "5": "4401ee4744eca6534f4484d35cc090db018b84574fdb72609ea59b001238640e",
      "6": "9e8bcbe79d0a74b9f7f5cc2366f85c164fe058d3ba86dae2965f5f87a9a75de1",
      "7": "49ed8c3030d1bdea668a8a2ed616d04df1a683e9796fa3e5f1ee450a36481675",
      "8": "238faa421ecaa0b478ad416ed44f29b93c8db6ecb9e1f551b0ba7c63208dcc62",
      "9": "2ed1bb1fb95b51331e58d476196fabe4914c99178e9b6677ab6c036a73924b4e",
    },
  },
  {
    registration: pythonRegistration,
    fixtures: "python",
    grammars: ["python"],
    minFiles: 30,
    fingerprints: {
      "1": "8f37d071cfb040a5f4e5e86e0ce58876756d4aa5460edab29f98cb2dcbcb54dc",
      "2": "68db627cf3d3a9726d5a25b8f83617a058562415c2d81e4f7e6312dc7349e730",
      "3": "68db627cf3d3a9726d5a25b8f83617a058562415c2d81e4f7e6312dc7349e730",
      "4": "d1957cbee7582f7bcd4c26c06eb64e7ae4134dc49b47ea97d8323f00ef969614",
    },
  },
  {
    registration: goRegistration,
    fixtures: "go",
    grammars: ["go"],
    minFiles: 30,
    fingerprints: {
      "1": "1ca97380485a034c9f90a2fd880c247128edf9e163f525d7c7287f4e970d686d",
      "2": "e7eb329c3ca3ed4e93b4444a3a5f8e60c7b18e2f7e98bb6a86aa2bb3f09d9ae9",
      "3": "e7eb329c3ca3ed4e93b4444a3a5f8e60c7b18e2f7e98bb6a86aa2bb3f09d9ae9",
      "4": "3c9768bff279b003ca45fbdfacd5b11c9232399fe04944009f007baadfa82602",
    },
  },
];

const FIXTURES = fileURLToPath(new URL("../../../fixtures/", import.meta.url));

describe("extract output is versioned", () => {
  for (const a of ADAPTERS) {
    const { adapter } = a.registration;
    it(`${adapter.id}: matches the fingerprint recorded for the current adapter version`, async () => {
      const dir = path.join(FIXTURES, a.fixtures);
      const files = fs
        .readdirSync(dir, { recursive: true, encoding: "utf8" })
        .map((f) => f.split(path.sep).join("/"))
        .filter((f) => a.registration.grammarFor(f) !== undefined)
        .sort();
      const parsers = await Parsers.load(a.grammars);
      const hash = createHash("sha256");
      try {
        for (const f of files) {
          const text = fs.readFileSync(path.join(dir, f), "utf8");
          const tree = parsers.parse(a.registration.grammarFor(f) ?? "", text);
          try {
            hash.update(
              `${f}\n${canonicalJson(adapter.extract({ path: f, text, tree }, CONFIG))}\n`,
            );
          } finally {
            tree.delete();
          }
        }
      } finally {
        parsers.dispose();
      }
      expect(files.length).toBeGreaterThan(a.minFiles);
      expect(
        hash.digest("hex"),
        `${adapter.id} extract output changed: bump its adapter version and record the new fingerprint`,
      ).toBe(a.fingerprints[adapter.version]);
    });
  }
});
