import childProcess from "node:child_process";
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

describe("discover: Python environments and caches", () => {
  it("skips virtual and conda environments by their marker, and tool caches", () => {
    const root = tree({
      "app.py": "",
      "pkg/mod.py": "",
      ".venv/pyvenv.cfg": "home = /usr/bin\n",
      ".venv/lib/python3.13/site-packages/requests/__init__.py": "",
      "envs/custom-name/pyvenv.cfg": "",
      "envs/custom-name/lib/x.py": "",
      "conda/conda-meta/history": "",
      "conda/lib/y.py": "",
      "pkg/__pycache__/mod.cpython-313.pyc": "",
      ".pytest_cache/v/cache/lastfailed": "",
      "venv/not-an-environment.py":
        "a folder named venv is not skipped by name",
    });
    const found = discover(root, { isSource: (p) => p.endsWith(".py") });
    expect(found.files).toEqual([
      "app.py",
      "pkg/mod.py",
      "venv/not-an-environment.py",
    ]);
  });

  it("still analyzes a project opened at an environment's root", () => {
    const root = tree({ "pyvenv.cfg": "", "tool.py": "" });
    expect(discover(root, { isSource: () => true }).files).toEqual([
      "pyvenv.cfg",
      "tool.py",
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

describe(
  "discover: files git tracks are never hidden by .gitignore",
  { timeout: 60_000 },
  () => {
    // No automatic maintenance: newer git runs it detached after a commit,
    // and a background git still writing in .git races a test that then
    // changes or reads it.
    const git = (cwd: string, ...args: string[]) =>
      childProcess.execFileSync(
        "git",
        [
          "-c",
          "user.email=t@example.com",
          "-c",
          "user.name=t",
          "-c",
          "maintenance.auto=false",
          "-c",
          "gc.auto=0",
          ...args,
        ],
        {
          cwd,
          encoding: "utf8",
          stdio: "pipe",
        },
      );

    function trackedRepo(init: string[] = []) {
      const root = tree({
        ".gitignore": "*.js\nvendor-dir/\n",
        ".epochignore": "secret.ts\n",
        "src/a.ts": "",
        "lib/vendor.js": "tracked despite *.js",
        "lib/untracked.js": "",
        "vendor-dir/kept.ts": "tracked inside an ignored directory",
        "vendor-dir/other.ts": "",
        "secret.ts": "tracked, but .epochignore is the user's explicit choice",
      });
      git(root, "init", "-q", ...init);
      git(root, "add", ".gitignore", ".epochignore", "src/a.ts", "secret.ts");
      git(root, "add", "-f", "lib/vendor.js", "vendor-dir/kept.ts");
      git(root, "commit", "-q", "-m", "init");
      return root;
    }

    const expected = [
      ".epochignore",
      ".gitignore",
      "lib/vendor.js",
      "src/a.ts",
      "vendor-dir/kept.ts",
    ];

    it("keeps tracked files that match ignore rules, and only those", () => {
      expect(discover(trackedRepo(), { isSource }).files).toEqual(expected);
    });

    it("reads index version 4 (prefix-compressed paths)", () => {
      const root = trackedRepo();
      git(root, "update-index", "--index-version", "4");
      expect(discover(root, { isSource }).files).toEqual(expected);
    });

    it("reads SHA-256 repositories", (ctx) => {
      let root: string;
      try {
        root = trackedRepo(["--object-format=sha256"]);
      } catch {
        ctx.skip(); // this git build has no SHA-256 support
        return;
      }
      expect(discover(root, { isSource }).files).toEqual(expected);
    });

    it("walks a build-output directory name only when git tracks files inside", () => {
      const files = {
        "internal/build/build.go": "package build",
        "dist/bundle.js": "",
        "coverage/lcov.info": "",
        "node_modules/dep/index.js": "",
      };
      const root = tree(files);
      git(root, "init", "-q");
      git(root, "add", "internal/build/build.go", "node_modules/dep/index.js");
      git(root, "commit", "-q", "-m", "init");
      // A tracked build/ is source (a Go package); node_modules never is.
      expect(discover(root, { isSource }).files).toEqual([
        "internal/build/build.go",
      ]);
      // Without git there is nothing to vouch for it (a separate tree, not
      // a deleted .git that git might still be writing to).
      expect(discover(tree(files), { isSource }).files).toEqual([]);
    });

    it("falls back to plain .gitignore rules without a readable index", () => {
      const root = trackedRepo();
      fs.writeFileSync(path.join(root, ".git", "index"), "garbage");
      expect(discover(root, { isSource }).files).toEqual([
        ".epochignore",
        ".gitignore",
        "src/a.ts",
      ]);
    });
  },
);
