import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/*
 * Where a model client may be in the built app (pnpm test builds first;
 * ADR-016). The analysis host, its parse workers, the preload and the
 * renderer never send anything, so none of them may carry one, through any
 * import. Main sends summaries, and loads the client only when it needs it:
 * a lazy chunk, never its entry or what the entry imports statically.
 */

const OUT = fileURLToPath(new URL("../out", import.meta.url));

/** Strings only the Anthropic SDK contains. */
const CLIENT = ["@anthropic-ai/sdk", "anthropic-version"];
/** ...and the model endpoints, which no process but main may even name. */
const ENDPOINTS = ["api.anthropic.com", "127.0.0.1:11434"];

const has =
  (needles: readonly string[]) =>
  (file: string): boolean => {
    const text = fs.readFileSync(file, "utf8");
    return needles.some((n) => text.includes(n));
  };
const carries = has([...CLIENT, ...ENDPOINTS]);

/**
 * The bundled files an entry loads: relative static imports, and with
 * `lazy` also dynamic import() targets.
 */
function closure(entry: string, lazy: boolean): string[] {
  const seen = new Set<string>();
  const visit = (file: string) => {
    if (seen.has(file)) return;
    seen.add(file);
    const text = fs.readFileSync(file, "utf8");
    const specifiers = [
      ...text.matchAll(/\b(?:from|import)\s*["'](\.{1,2}\/[^"']+)["']/g),
      ...text.matchAll(/\brequire\(\s*["'](\.{1,2}\/[^"']+)["']\s*\)/g),
      ...(lazy
        ? text.matchAll(/\bimport\(\s*["'](\.{1,2}\/[^"']+)["']\s*\)/g)
        : []),
    ].map((m) => m[1] ?? "");
    for (const s of specifiers) {
      const target = path.resolve(path.dirname(file), s);
      if (fs.existsSync(target)) visit(target);
    }
  };
  visit(entry);
  return [...seen];
}

const at = (...parts: string[]) => path.join(OUT, ...parts);

describe("the built app", () => {
  it.each([
    ["the analysis host", at("main", "host.js")],
    ["a parse worker", at("main", "parse-worker.js")],
    ["the preload", at("preload", "index.cjs")],
  ])("%s carries no model client, eagerly or lazily", (_name, entry) => {
    expect(fs.existsSync(entry)).toBe(true);
    expect(closure(entry, true).filter(carries)).toEqual([]);
  });

  it("main loads the model client only lazily", () => {
    const entry = at("main", "index.js");
    expect(fs.existsSync(entry)).toBe(true);
    // Main names the endpoints (consent asks about them), never the client.
    expect(closure(entry, false).filter(has(CLIENT))).toEqual([]);
    // The client is there, behind a dynamic import.
    expect(closure(entry, true).some(has(CLIENT))).toBe(true);
  });

  it("the renderer carries no model client and names no model endpoint", () => {
    const dir = at("renderer");
    const files = fs
      .readdirSync(dir, { recursive: true, encoding: "utf8" })
      .map((f) => path.join(dir, f))
      .filter((f) => fs.statSync(f).isFile() && /\.(?:c?js|mjs|html)$/.test(f));
    expect(files.length).toBeGreaterThan(0);
    expect(files.filter(carries)).toEqual([]);
  });

  it("finds the imports it follows", () => {
    // The host imports shared chunks; were the walker blind to them, every
    // check above would pass for nothing.
    expect(closure(at("main", "host.js"), true).length).toBeGreaterThan(1);
  });
});
