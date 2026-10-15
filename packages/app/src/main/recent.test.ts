import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MAX_RECENT, RecentProjects, addRecent } from "./recent";

let base: string;
beforeEach(() => {
  base = fs.mkdtempSync(path.join(os.tmpdir(), "epoch-recent-"));
});
afterEach(() => {
  fs.rmSync(base, { recursive: true, force: true });
});

const abs = (name: string) => path.join(base, name);

describe("addRecent", () => {
  it("puts the folder first, drops duplicates and caps the list", () => {
    expect(addRecent(["/a", "/b", "/c"], "/b")).toEqual(["/b", "/a", "/c"]);
    const many = Array.from({ length: MAX_RECENT }, (_, i) => `/p${String(i)}`);
    const next = addRecent(many, "/new");
    expect(next).toHaveLength(MAX_RECENT);
    expect(next[0]).toBe("/new");
    expect(next).not.toContain(`/p${String(MAX_RECENT - 1)}`);
  });
});

describe("RecentProjects", () => {
  it("persists the list across instances", () => {
    const file = path.join(base, "data", "recent-projects.json");
    const first = new RecentProjects(file);
    expect(first.projects).toEqual([]);
    first.add(abs("one"));
    first.add(abs("two"));
    expect(new RecentProjects(file).projects).toEqual([abs("two"), abs("one")]);
    expect(fs.existsSync(`${file}.tmp`)).toBe(false);
  });

  it("starts empty from a missing, corrupt or foreign file", () => {
    const file = path.join(base, "recent-projects.json");
    for (const content of [
      "not json",
      JSON.stringify({ version: 2, projects: [abs("x")] }),
      JSON.stringify({ version: 1, projects: [42] }),
    ]) {
      fs.writeFileSync(file, content);
      expect(new RecentProjects(file).projects).toEqual([]);
    }
  });

  it("drops relative entries", () => {
    const file = path.join(base, "recent-projects.json");
    fs.writeFileSync(
      file,
      JSON.stringify({ version: 1, projects: ["relative", abs("ok")] }),
    );
    expect(new RecentProjects(file).projects).toEqual([abs("ok")]);
  });
});
