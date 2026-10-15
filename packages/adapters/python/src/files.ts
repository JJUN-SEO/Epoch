/** Extensions this adapter analyzes: modules and type stubs. */
export const EXTENSIONS = [".py", ".pyi"] as const;

const PY_FILE = /\.pyi?$/;

/** Grammar for a repo-relative path (ADR-002), or undefined if not ours. */
export function grammarFor(path: string): string | undefined {
  return PY_FILE.test(path) ? "python" : undefined;
}

export function languageFor(_path: string): string {
  return "python";
}

const TEST_NAME = /^(?:test_.*|.*_test|conftest)\.pyi?$/;
const TEST_DIR = /(?:^|\/)tests?\//;

/** pytest's default discovery names (test_*.py, *_test.py), conftest.py, and tests/ folders. */
export function isTestFile(path: string): boolean {
  const name = path.slice(path.lastIndexOf("/") + 1);
  return TEST_NAME.test(name) || TEST_DIR.test(path);
}
