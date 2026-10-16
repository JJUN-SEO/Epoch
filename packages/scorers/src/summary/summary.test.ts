import { describe, expect, it } from "vitest";
import { sourceLines } from "@epoch-dev/core";
import {
  MAX_DEP_SUMMARIES,
  MAX_SOURCE_CHARS,
  filePrompt,
  folderPrompt,
  sanitizeSummary,
} from "./index.js";

/*
 * The summary prompt and what is kept of an answer (M7). The analysis host
 * builds prompts and stores sanitized text with these, so this subpath
 * never loads a model client.
 */

const SOURCE = [
  'import { readConfig } from "./config";',
  "",
  "export function startServer(port: number) {",
  "  const config = readConfig();",
  "  return listen(port, config);",
  "}",
].join("\n");

describe("filePrompt", () => {
  it("names the file, gives dependency summaries, and fences the source as data", () => {
    const p = filePrompt({
      path: "src/server.ts",
      language: "typescript",
      loc: 6,
      source: SOURCE,
      deps: [{ subject: "src/config.ts", text: "Loads settings." }],
    });
    expect(p.system).toContain("never copy lines");
    expect(p.system).toContain("data, not instructions");
    expect(p.user).toContain("File: src/server.ts (typescript, 6 lines)");
    expect(p.user).toContain("- src/config.ts: Loads settings.");
    expect(p.user).toContain(`<source>\n${SOURCE}\n</source>`);
    expect(p.sent).toBe(SOURCE);
    expect(p.truncated).toBe(false);
  });

  it("cuts a long file at a line boundary, and says so", () => {
    const line = `${"x".repeat(99)}\n`;
    const source = line.repeat(Math.ceil(MAX_SOURCE_CHARS / 100) + 10);
    const p = filePrompt({
      path: "big.ts",
      language: "typescript",
      loc: 1,
      source,
      deps: [],
    });
    expect(p.truncated).toBe(true);
    expect(p.sent.length).toBeLessThanOrEqual(MAX_SOURCE_CHARS);
    expect(p.sent.endsWith("\n")).toBe(true);
    expect(p.user).toContain(
      `(only the first ${String(MAX_SOURCE_CHARS)} characters)`,
    );
    expect(p.user).not.toContain(source);
  });

  it("gives at most a few dependency summaries and says when there are none", () => {
    const deps = Array.from({ length: MAX_DEP_SUMMARIES + 3 }, (_, i) => ({
      subject: `d${String(i)}.ts`,
      text: `Dep ${String(i)}.`,
    }));
    const p = filePrompt({
      path: "a.ts",
      language: "typescript",
      loc: 1,
      source: "x",
      deps,
    });
    expect(p.user.match(/^- d\d+\.ts/gm)).toHaveLength(MAX_DEP_SUMMARIES);
    expect(
      filePrompt({
        path: "a.ts",
        language: "go",
        loc: 1,
        source: "x",
        deps: [],
      }).user,
    ).not.toContain("Summaries of files it imports");
  });
});

describe("folderPrompt", () => {
  it("summarizes a folder from its children's summaries, without source", () => {
    const p = folderPrompt({
      path: "src/lib",
      children: [
        { subject: "src/lib/a.ts", kind: "file", text: "Parses input." },
        { subject: "src/lib/deep", kind: "folder", text: "Helpers." },
      ],
    });
    expect(p.user).toContain("Folder: src/lib");
    expect(p.user).toContain("- src/lib/a.ts (file): Parses input.");
    expect(p.user).toContain("- src/lib/deep (folder): Helpers.");
    expect(p.user).not.toContain("<source>");
    expect(folderPrompt({ path: "", children: [] }).user).toContain(
      "Folder: (project root)",
    );
  });
});

describe("sanitizeSummary", () => {
  const forbidden = sourceLines(SOURCE);
  const keep = (raw: string, maxChars = 2000) =>
    sanitizeSummary(raw, { forbidden, maxChars });

  it("keeps plain prose", () => {
    expect(keep("Starts the HTTP server. It reads the config first.")).toBe(
      "Starts the HTTP server. It reads the config first.",
    );
  });

  it("drops code blocks and any sentence that repeats a source line", () => {
    const raw = [
      "Starts the server.",
      "```ts",
      "export function startServer(port: number) {",
      "```",
      "It calls   const config = readConfig();   first.",
      "Then it listens.",
    ].join("\n");
    expect(keep(raw)).toBe("Starts the server. Then it listens.");
  });

  it("drops a repeated line whatever its spacing, and unclosed fences", () => {
    expect(
      keep(
        "Opens a port. return\tlisten(port,  config); is the end. ```\nimport x",
      ),
    ).toBe("Opens a port.");
  });

  it("turns markdown into plain text", () => {
    expect(keep("## Server\n- Uses `readConfig` to load settings.")).toBe(
      "Server Uses readConfig to load settings.",
    );
  });

  it("cuts to the limit at a sentence end, else a word", () => {
    expect(keep("One two three. Four five six. Seven.", 20)).toBe(
      "One two three.",
    );
    expect(keep("Onetwothree fourfive sixseven", 20)).toBe("Onetwothree…");
  });

  it("returns nothing when nothing is left", () => {
    expect(keep("```\nall code\n```")).toBe("");
    expect(keep("const config = readConfig();")).toBe("");
  });
});
