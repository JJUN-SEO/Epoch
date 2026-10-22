import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DismissalStore } from "./dismissals.js";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0))
    fs.rmSync(d, { recursive: true, force: true });
});
const tmp = () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "epoch-dismiss-"));
  dirs.push(d);
  return d;
};
const ID = "a".repeat(64);
const AT = new Date("2026-06-01T12:00:00Z");

describe("DismissalStore", () => {
  it("persists dismissals per project, outside the project, across instances", () => {
    const data = tmp();
    const project = tmp();
    const store = DismissalStore.forProject(project, data);
    store.dismiss(ID, "kept on purpose", AT);
    expect(store.location.startsWith(data)).toBe(true);
    expect(fs.readdirSync(project)).toEqual([]); // nothing written into the project

    const again = DismissalStore.forProject(project, data);
    expect([...again.ids()]).toEqual([ID]);
    expect(again.list()).toEqual([
      { id: ID, at: AT.toISOString(), note: "kept on purpose" },
    ]);
    expect(DismissalStore.forProject(tmp(), data).ids().size).toBe(0); // another project

    again.undismiss(ID);
    expect(DismissalStore.forProject(project, data).ids().size).toBe(0);
  });

  it("writes owner-only files", () => {
    if (process.platform === "win32") return; // POSIX permissions only
    const store = DismissalStore.forProject(tmp(), tmp());
    store.dismiss(ID);
    expect(fs.statSync(store.location).mode & 0o777).toBe(0o600);
    expect(fs.statSync(path.dirname(store.location)).mode & 0o777).toBe(0o700);
  });

  it("refuses malformed ids and overlong notes", () => {
    const store = DismissalStore.forProject(tmp(), tmp());
    expect(() => {
      store.dismiss("../../etc");
    }).toThrow();
    expect(() => {
      store.dismiss("");
    }).toThrow();
    expect(() => {
      store.dismiss(ID, "x".repeat(1001));
    }).toThrow();
    expect(store.ids().size).toBe(0);
  });

  it("drops blank notes and sees other writers' changes", () => {
    const data = tmp();
    const project = tmp();
    const a = DismissalStore.forProject(project, data);
    const b = DismissalStore.forProject(project, data);
    a.dismiss(ID, "   ", AT);
    b.dismiss("b".repeat(64), undefined, AT);
    a.reload();
    expect(a.list()).toEqual([
      { id: ID, at: AT.toISOString() },
      { id: "b".repeat(64), at: AT.toISOString() },
    ]);
  });

  it("sets an unreadable file aside instead of overwriting it", () => {
    const store = DismissalStore.forProject(tmp(), tmp());
    store.dismiss(ID);
    fs.writeFileSync(store.location, "{ not json");
    store.reload();
    expect(store.ids().size).toBe(0);
    expect(fs.existsSync(`${store.location}.unreadable`)).toBe(true);
    store.dismiss(ID);
    expect(store.ids().size).toBe(1);
  });
});
