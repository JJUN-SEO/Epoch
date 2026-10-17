import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ConsentStore } from "./consent-store";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0))
    fs.rmSync(d, { recursive: true, force: true });
});

describe("ConsentStore", () => {
  it("remembers consent per project and provider, across restarts", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "epoch-consent-"));
    dirs.push(dir);
    const f = path.join(dir, "consent.json");
    const store = new ConsentStore(f);
    expect(store.has("/p", "anthropic")).toBe(false);
    store.grant("/p", "anthropic");
    expect(store.has("/p", "anthropic")).toBe(true);
    expect(store.has("/q", "anthropic")).toBe(false);
    expect(new ConsentStore(f).has("/p", "anthropic")).toBe(true);
    store.revoke("/p");
    expect(new ConsentStore(f).has("/p", "anthropic")).toBe(false);
  });
});
