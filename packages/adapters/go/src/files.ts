/** Extensions this adapter analyzes. */
export const EXTENSIONS = [".go"] as const;

/**
 * Whether a repo-relative path is a file the go tool would build (ADR-013,
 * from `go help packages`): files and directories starting with "." or "_",
 * directories named testdata, and vendored code are not part of the project's
 * packages.
 */
export function isPackageFile(path: string): boolean {
  if (!path.endsWith(".go")) return false;
  const parts = path.split("/");
  const name = parts[parts.length - 1] ?? "";
  if (name === ".go") return false;
  return parts.every(
    (p, i) =>
      !p.startsWith(".") &&
      !p.startsWith("_") &&
      (i === parts.length - 1 || (p !== "testdata" && p !== "vendor")),
  );
}

/** Grammar for a repo-relative path (ADR-002), or undefined if not ours. */
export function grammarFor(path: string): string | undefined {
  return isPackageFile(path) ? "go" : undefined;
}

export function languageFor(_path: string): string {
  return "go";
}

/** The go tool's test files: names ending in _test.go. */
export function isTestFile(path: string): boolean {
  return path.endsWith("_test.go");
}
