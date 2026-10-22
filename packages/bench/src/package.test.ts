import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// The M0 contract every workspace package keeps (PLAN.md M0: "Each has build,
// test, and lint scripts"), checked against the real manifest and the real
// build output. `pnpm test` builds the package first (turbo.json: test
// dependsOn build). Paths go through URL objects, never `.pathname`, so they
// work on Windows and in directories with spaces.
const EXPECTED_NAME = "@epoch-dev/bench";

const packageDir = new URL("../", import.meta.url);
const manifest: unknown = JSON.parse(
  readFileSync(new URL("package.json", packageDir), "utf8"),
);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function field(record: unknown, key: string): unknown {
  return isRecord(record) ? record[key] : undefined;
}

describe(`${EXPECTED_NAME} package`, () => {
  it("follows the workspace manifest conventions", () => {
    expect(field(manifest, "name")).toBe(EXPECTED_NAME);
    expect(field(manifest, "private")).toBe(true);
    expect(field(manifest, "type")).toBe("module");
    expect(field(manifest, "license")).toBe("MIT");
    const scripts = field(manifest, "scripts");
    for (const script of ["build", "typecheck", "lint", "test"]) {
      expect(typeof field(scripts, script), `scripts.${script}`).toBe("string");
    }
  });

  it("exports its build output with the types condition first", () => {
    const entry = field(field(manifest, "exports"), ".");
    expect(entry).toEqual({
      types: "./dist/index.d.ts",
      default: "./dist/index.js",
    });
    expect(isRecord(entry) ? Object.keys(entry) : []).toEqual([
      "types",
      "default",
    ]);
    expect(existsSync(new URL("dist/index.d.ts", packageDir))).toBe(true);
    expect(existsSync(new URL("dist/index.js", packageDir))).toBe(true);
  });

  it("keeps test files out of the build output", () => {
    const emitted = readdirSync(new URL("dist/", packageDir), {
      recursive: true,
      encoding: "utf8",
    });
    // Vitest's default include matches both *.test.* and *.spec.* files.
    expect(emitted.filter((file) => /\.(test|spec)\./.test(file))).toEqual([]);
  });

  it("emits an entry point that Node's own ESM loader accepts", () => {
    // Vitest's module runner is more lenient than Node (it accepts
    // extensionless relative imports, for example), so load it in plain Node.
    const entry = fileURLToPath(new URL("dist/index.js", packageDir));
    expect(() =>
      execFileSync(process.execPath, [entry], { stdio: "pipe" }),
    ).not.toThrow();
    // Loading the TypeScript compiler in a cold Node can take seconds on a
    // busy CI runner; this checks loading, not speed.
  }, 60_000);
});
