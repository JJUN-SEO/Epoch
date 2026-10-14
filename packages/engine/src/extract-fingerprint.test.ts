import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { EMPTY_EXTRACTOR_CONFIG, canonicalJson } from "@epoch-dev/core";
import { typescriptRegistration } from "@epoch-dev/adapter-typescript";
import { Parsers } from "./parse.js";

/**
 * Cache-poisoning guard (PLAN.md M2 pitfall, ADR-004): cached FileFacts are
 * keyed by the adapter version, so any change to what `extract` produces
 * must come with a version bump. This fingerprints extract output over every
 * TS/JS fixture file; when it changes, bump the adapter version and record the
 * new fingerprint here in the same commit.
 */
const FINGERPRINTS: Readonly<Record<string, string>> = {
  "2": "7b4596afcf409ec576fad84df17053c121e887132cd73fb53b93dbf03909d17c",
  "3": "96f756fc7ab66755421042464d1f368f10c85b7867149da9c4717af684dbc240",
};

const FIXTURES = fileURLToPath(
  new URL("../../../fixtures/typescript/", import.meta.url),
);

describe("TS/JS extract output is versioned", () => {
  it("matches the fingerprint recorded for the current adapter version", async () => {
    const reg = typescriptRegistration;
    const { adapter } = reg;
    const files = fs
      .readdirSync(FIXTURES, { recursive: true, encoding: "utf8" })
      .map((f) => f.split(path.sep).join("/"))
      .filter((f) => reg.grammarFor(f) !== undefined)
      .sort();
    const parsers = await Parsers.load(["typescript", "tsx", "javascript"]);
    const hash = createHash("sha256");
    try {
      for (const f of files) {
        const text = fs.readFileSync(path.join(FIXTURES, f), "utf8");
        const tree = parsers.parse(reg.grammarFor(f) ?? "", text);
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
    expect(files.length).toBeGreaterThan(40);
    expect(
      hash.digest("hex"),
      `extract output changed: bump typescriptAdapter.version and record the new fingerprint`,
    ).toBe(FINGERPRINTS[adapter.version]);
  });
});
