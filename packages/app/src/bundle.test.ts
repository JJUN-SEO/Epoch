import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/*
 * M6's model scorers (Ollama, Claude) are for the CLI and benchmarks only;
 * the desktop app gets model features, keys and consent in M7 (CLAUDE.md
 * "Privacy and data flow"). This checks the built app (pnpm test builds
 * first) carries no model client and names no model endpoint.
 */

const OUT = fileURLToPath(new URL("../out", import.meta.url));

function files(dir: string): string[] {
  return fs
    .readdirSync(dir, { recursive: true, encoding: "utf8" })
    .map((f) => path.join(dir, f))
    .filter((f) => fs.statSync(f).isFile() && /\.(?:c?js|mjs|html)$/.test(f));
}

describe("the built app", () => {
  it("carries no model client and names no model endpoint", () => {
    const built = files(OUT);
    expect(built.some((f) => f.endsWith("host.js"))).toBe(true);
    const hits = built.filter((f) => {
      const text = fs.readFileSync(f, "utf8");
      return ["api.anthropic.com", "@anthropic-ai/sdk", "127.0.0.1:11434"].some(
        (needle) => text.includes(needle),
      );
    });
    expect(hits).toEqual([]);
  });
});
