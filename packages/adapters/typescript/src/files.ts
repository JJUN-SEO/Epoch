/** Extensions this adapter analyzes (`.d.ts` is covered by `.ts`). */
export const EXTENSIONS = [
  ".ts",
  ".tsx",
  ".mts",
  ".cts",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
] as const;

const TS_FILE = /\.(?:ts|tsx|mts|cts)$/;
const JS_FILE = /\.(?:js|jsx|mjs|cjs)$/;

/** Grammar for a repo-relative path (ADR-002), or undefined if not ours. */
export function grammarFor(path: string): string | undefined {
  if (path.endsWith(".tsx")) return "tsx";
  if (TS_FILE.test(path)) return "typescript";
  if (JS_FILE.test(path)) return "javascript";
  return undefined;
}

/** GraphNode.language: "typescript" for TS files (including .d.ts), else "javascript". */
export function languageFor(path: string): string {
  return TS_FILE.test(path) ? "typescript" : "javascript";
}

const TEST_FILE = /\.(?:test|spec)\.[cm]?[jt]sx?$/;
const TEST_DIR = /(?:^|\/)__tests__\//;

/** Test files are roots for reachability (M5) and never reported as unreachable. */
export function isTestFile(path: string): boolean {
  return TEST_FILE.test(path) || TEST_DIR.test(path);
}
