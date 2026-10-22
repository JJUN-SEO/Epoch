import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { UpdateStore } from "./update-store";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0))
    fs.rmSync(d, { recursive: true, force: true });
});

function file(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "epoch-update-"));
  dirs.push(dir);
  return path.join(dir, "update-check.json");
}

describe("UpdateStore", () => {
  it("reads as never checked until written, then keeps the record", () => {
    const f = file();
    expect(new UpdateStore(f).read()).toEqual({ lastCheckedAt: 0 });
    new UpdateStore(f).write({ lastCheckedAt: 1234, latest: "v0.2.0" });
    expect(new UpdateStore(f).read()).toEqual({
      lastCheckedAt: 1234,
      latest: "v0.2.0",
    });
    if (process.platform !== "win32")
      expect(fs.statSync(f).mode & 0o777).toBe(0o600);
  });

  it.each([
    "not json",
    JSON.stringify({ version: 2, lastCheckedAt: 1 }),
    JSON.stringify({ version: 1, lastCheckedAt: -5 }),
    JSON.stringify({ version: 1, lastCheckedAt: 1, latest: "v1.0.0-rc.1" }),
    JSON.stringify({ version: 1, lastCheckedAt: 1, latest: "x".repeat(100) }),
  ])("reads a damaged file as never checked: %s", (text) => {
    const f = file();
    fs.writeFileSync(f, text);
    expect(new UpdateStore(f).read()).toEqual({ lastCheckedAt: 0 });
  });
});
