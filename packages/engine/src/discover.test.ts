import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { discover } from "./discover.js";
import { FsReader } from "./reader.js";

const temps: string[] = [];
afterAll(() => {
  for (const t of temps) fs.rmSync(t, { recursive: true, force: true });
});

/** Creates a temp tree from { "rel/path": contents }. */
function tree(files: Record<string, string>): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "epoch-discover-"));
  temps.push(root);
  for (const [rel, text] of Object.entries(files)) {
    const abs = path.join(root, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, text);
  }
  return root;
}

const isSource = (p: string) => /\.(ts|tsx|js)$/.test(p);

describe("discover", () => {
  const root = tree({
    ".gitignore": "*.log\nignored-dir/\n/rooted.ts\n",
    ".epochignore": "secret/\n",
    "src/a.ts": "export const a = 1;\n",
    "src/b.tsx": "export {}\n",
    "src/notes.log": "x",
    "src/rooted.ts": "nested files are not matched by a rooted pattern",
    "rooted.ts": "matched by /rooted.ts",
    "README.md": "# hi\n",
    "ignored-dir/x.ts": "",
    "secret/key.ts": "",
    "sub/.gitignore": "local.ts\n!re.log\n",
    "sub/local.ts": "",
    "sub/kept.ts": "",
    "sub/re.log": "re-included by the deeper ignore file",
    "node_modules/pkg/index.js": "",
    "dist/out.js": "",
    "packages/app/dist/out.js": "",
    "big.ts": "x".repeat(200),
  });
  const external = tree({ "outside.ts": "export {}\n" });
  const linkType = process.platform === "win32" ? "junction" : "dir";
  fs.symlinkSync(path.join(external), path.join(root, "linked"), linkType);

  const result = discover(root, { isSource, maxFileBytes: 100 });

  it("lists non-ignored files, sorted, with forward slashes", () => {
    expect(result.files).toEqual([
      ".epochignore",
      ".gitignore",
      "README.md",
      "src/a.ts",
      "src/b.tsx",
      "src/rooted.ts",
      "sub/.gitignore",
      "sub/kept.ts",
      "sub/re.log",
    ]);
  });

  it("returns an absolute root with forward slashes", () => {
    expect(result.root).not.toContain("\\");
    expect(path.resolve(result.root)).toBe(path.resolve(root));
  });

  it("records symlinks and oversized source files as skipped", () => {
    expect(result.skipped).toEqual([
      { path: "big.ts", reason: "too-large" },
      { path: "linked", reason: "symlink" },
    ]);
  });
});

describe("FsReader", () => {
  const root = tree({
    "src/a.ts": "export const a = 1;\n",
    "tsconfig.json": "{}",
  });
  const outside = tree({ "secret.txt": "nope" });
  const reader = new FsReader(root);
  const r = (rel: string) => `${root.split(path.sep).join("/")}/${rel}`;

  it("reads files inside the root", () => {
    expect(reader.readFile(r("src/a.ts"))).toBe("export const a = 1;\n");
    expect(reader.fileExists(r("tsconfig.json"))).toBe(true);
    expect(reader.directoryExists(r("src"))).toBe(true);
    expect(reader.getDirectories(r(""))).toEqual(["src"]);
  });

  it("refuses paths outside the root, including traversal", () => {
    const secret = path.join(outside, "secret.txt");
    expect(reader.readFile(secret)).toBeUndefined();
    expect(
      reader.fileExists(r("../" + path.basename(outside) + "/secret.txt")),
    ).toBe(false);
    expect(reader.directoryExists(path.dirname(root))).toBe(false);
  });

  it("works when the root itself sits behind a symlink (macOS /var -> /private/var)", () => {
    const real = tree({ "src/a.ts": "export {}\n" });
    const parent = fs.mkdtempSync(path.join(os.tmpdir(), "epoch-symroot-"));
    temps.push(parent);
    const linked = path.join(parent, "project");
    fs.symlinkSync(
      real,
      linked,
      process.platform === "win32" ? "junction" : "dir",
    );
    const viaLink = new FsReader(linked);
    const abs = `${linked.split(path.sep).join("/")}/src/a.ts`;
    expect(viaLink.readFile(abs)).toBe("export {}\n");
  });

  it("refuses symlinks that point outside the root", () => {
    const linkType = process.platform === "win32" ? "junction" : "dir";
    fs.symlinkSync(outside, path.join(root, "escape"), linkType);
    expect(reader.readFile(r("escape/secret.txt"))).toBeUndefined();
    expect(reader.fileExists(r("escape/secret.txt"))).toBe(false);
    expect(reader.realpath(r("escape"))).toBe(r("escape"));
  });
});
