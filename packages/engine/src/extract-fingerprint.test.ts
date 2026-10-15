import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { Tree } from "web-tree-sitter";
import {
  EMPTY_EXTRACTOR_CONFIG,
  canonicalJson,
  type AdapterRegistration,
} from "@epoch-dev/core";
import { pythonRegistration } from "@epoch-dev/adapter-python";
import { typescriptRegistration } from "@epoch-dev/adapter-typescript";
import { Parsers } from "./parse.js";

/**
 * Cache-poisoning guard (PLAN.md M2 pitfall, ADR-004): cached FileFacts are
 * keyed by the adapter version, so any change to what `extract` produces
 * must come with a version bump. This fingerprints each adapter's extract
 * output over every fixture file of its language; when it changes, bump the
 * adapter version and record the new fingerprint here in the same commit.
 */
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
    },
  },
  {
    registration: pythonRegistration,
    fixtures: "python",
    grammars: ["python"],
    minFiles: 30,
    fingerprints: {
      "1": "d549692cbaf4c1c35b7eaf69cd79c74ea8f2185a02c161513d60a1a82bf1296d",
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
              `${f}\n${canonicalJson(adapter.extract({ path: f, text, tree }, EMPTY_EXTRACTOR_CONFIG))}\n`,
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
