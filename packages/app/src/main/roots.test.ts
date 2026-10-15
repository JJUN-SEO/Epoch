import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GrantedRoots, NotGrantedError } from "./roots";

let base: string;
const dir = (name: string) => {
  const p = path.join(base, name);
  fs.mkdirSync(p, { recursive: true });
  return p;
};

/** Directory symlinks need a junction on Windows (no admin rights needed). */
function link(target: string, at: string): void {
  fs.symlinkSync(target, at, process.platform === "win32" ? "junction" : "dir");
}

beforeEach(() => {
  base = fs.realpathSync.native(
    fs.mkdtempSync(path.join(os.tmpdir(), "epoch-roots-")),
  );
});

afterEach(() => {
  fs.rmSync(base, { recursive: true, force: true });
});

describe("GrantedRoots", () => {
  it("resolves a granted folder and refuses everything else", () => {
    const roots = new GrantedRoots();
    const project = dir("project");
    const other = dir("other");
    expect(roots.grant(project)).toBe(project);
    expect(roots.resolve(project)).toBe(project);
    expect(() => roots.resolve(other)).toThrow(NotGrantedError);
    expect(() => roots.resolve(path.join(project, "sub"))).toThrow(
      NotGrantedError,
    );
    expect(() => roots.resolve(path.dirname(project))).toThrow(NotGrantedError);
  });

  it("refuses relative paths, files and missing folders", () => {
    const roots = new GrantedRoots();
    const file = path.join(base, "file.txt");
    fs.writeFileSync(file, "x");
    expect(() => roots.grant("relative/folder")).toThrow(/absolute/);
    expect(() => roots.grant(file)).toThrow(/Not a folder/);
    expect(() => roots.grant(path.join(base, "missing"))).toThrow();
    expect(() => roots.resolve("relative/folder")).toThrow(NotGrantedError);
  });

  it("judges a symlink by its target", () => {
    const roots = new GrantedRoots();
    const project = dir("project");
    const secret = dir("secret");
    roots.grant(project);
    link(secret, path.join(base, "looks-like-project"));
    link(project, path.join(base, "alias"));
    expect(() => roots.resolve(path.join(base, "looks-like-project"))).toThrow(
      NotGrantedError,
    );
    expect(roots.resolve(path.join(base, "alias"))).toBe(project);
  });

  it("grants a stored recent folder only while it is still the same real folder", () => {
    const roots = new GrantedRoots();
    const project = dir("project");
    const secret = dir("secret");
    expect(roots.grantStored(project)).toBe(true);
    expect(roots.resolve(project)).toBe(project);

    // A stored folder replaced by a link to somewhere else is not re-granted.
    const swapped = dir("swapped");
    fs.rmSync(swapped, { recursive: true });
    link(secret, swapped);
    const fresh = new GrantedRoots();
    expect(fresh.grantStored(swapped)).toBe(false);
    expect(() => fresh.resolve(swapped)).toThrow(NotGrantedError);
    expect(fresh.grantStored(path.join(base, "missing"))).toBe(false);
  });
});
