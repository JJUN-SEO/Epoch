import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_EPOCH_CONFIG } from "@epoch-dev/core";
import { analyze } from "./analyze.js";
import { MemoryCacheStore } from "./cache/memory-store.js";
import { MAX_CONFIG_BYTES, extractorConfigOf, loadConfig } from "./config.js";
import { toPosix } from "./discover.js";
import { FsReader } from "./reader.js";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0))
    fs.rmSync(d, { recursive: true, force: true });
});

function project(files: Record<string, string>): string {
  const dir = toPosix(
    fs.realpathSync.native(
      fs.mkdtempSync(path.join(os.tmpdir(), "epoch-config-")),
    ),
  );
  dirs.push(dir);
  for (const [rel, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), text);
  }
  return dir;
}

const load = (config: string | undefined) => {
  const dir = project(
    config === undefined ? {} : { "epoch.config.json": config },
  );
  return loadConfig(dir, new FsReader(dir));
};

describe("loadConfig", () => {
  it("gives the defaults when there is no config", () => {
    expect(load(undefined)).toEqual({
      config: DEFAULT_EPOCH_CONFIG,
      present: false,
      warnings: [],
    });
  });

  it("reads a valid config and warns about unknown keys", () => {
    const r = load(
      JSON.stringify({
        entryPoints: ["src/main.ts"],
        flags: { envPrefixes: ["FEATURE_"], typo: 1 },
        extra: true,
      }),
    );
    expect(r.present).toBe(true);
    expect(r.config.entryPoints).toEqual(["src/main.ts"]);
    expect(r.config.flags.envPrefixes).toEqual(["FEATURE_"]);
    expect(r.config.flags.staleAfterDays).toBe(90);
    expect(r.warnings).toEqual([
      'epoch.config.json: unknown key "extra" (ignored)',
      'epoch.config.json: unknown key "flags.typo" (ignored)',
    ]);
  });

  it.each([
    ["{ not json", "not valid JSON"],
    ["[1, 2]", "not a JSON object"],
    [
      JSON.stringify({ flags: { staleAfterDays: -1 } }),
      "invalid (flags.staleAfterDays",
    ],
    [JSON.stringify({ ignore: "x" }), "invalid (ignore"],
    [" ".repeat(MAX_CONFIG_BYTES + 1), "larger than 64 KiB"],
  ])("falls back to the defaults, with a warning, for %#", (text, warning) => {
    const r = load(text);
    expect(r.config).toEqual(DEFAULT_EPOCH_CONFIG);
    expect(r.present).toBe(true);
    expect(r.warnings).toHaveLength(1);
    expect(r.warnings[0]).toContain(warning);
  });

  it("drops glob patterns the matcher refuses, keeping the rest", () => {
    const r = load(JSON.stringify({ ignore: ["{a,b}".repeat(12), "gen/**"] }));
    expect(r.config.ignore).toEqual(["gen/**"]);
    expect(r.warnings[0]).toContain("ignore pattern dropped");
  });

  it("puts the pattern packs, wrappers and env prefixes in the extractor config", () => {
    const r = load(JSON.stringify({ flags: { wrapperFunctions: ["isOn"] } }));
    const cfg = extractorConfigOf(r.config);
    expect(cfg.wrapperFunctions).toEqual(["isOn"]);
    expect(cfg.flagPatterns.length).toBeGreaterThan(0);
  });
});

describe("analyze with epoch.config.json", () => {
  it("removes ignored paths from the analysis entirely", async () => {
    const dir = project({
      "epoch.config.json": JSON.stringify({ ignore: ["**/generated/**"] }),
      "src/a.ts": 'import { g } from "./generated/g";\nexport const a = g;\n',
      "src/generated/g.ts": "export const g = 1;\n",
    });
    const { graph, config } = await analyze(dir, { history: false });
    expect(graph.nodes.map((n) => n.id)).toEqual(["src/a.ts"]);
    expect(graph.unresolved).toMatchObject([
      // On disk but not analyzed, as for a gitignored file.
      {
        from: "src/a.ts",
        specifier: "./generated/g",
        reason: "outside-project",
      },
    ]);
    expect(config.present).toBe(true);
  });

  it("re-extracts every file when the flag settings change (cache keys)", async () => {
    const dir = project({ "src/a.ts": "export const a = 1;\n" });
    const cache = new MemoryCacheStore();
    await analyze(dir, { cache, history: false });
    const warm = await analyze(dir, { cache, history: false });
    expect(warm.meta.counts.cacheHits).toBe(1);
    fs.writeFileSync(
      path.join(dir, "epoch.config.json"),
      JSON.stringify({ flags: { envPrefixes: ["FEATURE_"] } }),
    );
    const changed = await analyze(dir, { cache, history: false });
    expect(changed.meta.counts.cacheMisses).toBe(1);
  });
});
