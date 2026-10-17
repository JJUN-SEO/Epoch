import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS } from "@epoch-dev/core";
import { SettingsNotConfirmed, SettingsStore } from "./settings-store";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0))
    fs.rmSync(d, { recursive: true, force: true });
});

function file(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "epoch-settings-"));
  dirs.push(dir);
  return path.join(dir, "settings.json");
}

const yes = () => Promise.resolve(true);
const no = () => Promise.resolve(false);

describe("SettingsStore", () => {
  it("starts from the defaults and keeps what is saved", async () => {
    const f = file();
    const store = new SettingsStore(f);
    expect(store.get()).toEqual(DEFAULT_SETTINGS);
    await store.update({ offline: true, summaries: { enabled: true } }, yes);
    const again = new SettingsStore(f);
    expect(again.get().offline).toBe(true);
    expect(again.get().summaries.enabled).toBe(true);
    if (process.platform !== "win32")
      expect(fs.statSync(f).mode & 0o777).toBe(0o600);
  });

  it("asks before letting Epoch spend more, and changes nothing when refused", async () => {
    const f = file();
    const store = new SettingsStore(f);
    const asked: string[][] = [];
    const ask = (raises: readonly string[]) => {
      asked.push([...raises]);
      return Promise.resolve(false);
    };
    await expect(
      store.update({ spend: { monthlyCapUsd: 5 } }, ask),
    ).rejects.toBeInstanceOf(SettingsNotConfirmed);
    expect(asked).toEqual([["monthly cap none → $5.00"]]);
    expect(store.get().spend.monthlyCapUsd).toBeUndefined();
    expect(fs.existsSync(f)).toBe(false);
    // Lowering never asks.
    await store.update({ spend: { monthlyCapUsd: 5 } }, yes);
    await store.update({ spend: { monthlyCapUsd: 2 } }, no);
    expect(store.get().spend.monthlyCapUsd).toBe(2);
  });

  it("refuses an invalid patch", async () => {
    const store = new SettingsStore(file());
    await expect(store.update({ telemetry: true }, yes)).rejects.toThrow();
    expect(store.get()).toEqual(DEFAULT_SETTINGS);
  });

  it("falls back per section from a damaged file, and says so", () => {
    const f = file();
    fs.writeFileSync(f, JSON.stringify({ offline: true, spend: "lots" }));
    const store = new SettingsStore(f);
    expect(store.get().offline).toBe(true);
    expect(store.get().spend).toEqual(DEFAULT_SETTINGS.spend);
    expect(store.warnings).toHaveLength(1);
    fs.writeFileSync(f, "{not json");
    expect(new SettingsStore(f).get()).toEqual(DEFAULT_SETTINGS);
  });

  it("tells listeners about each change", async () => {
    const store = new SettingsStore(file());
    const seen: boolean[] = [];
    const stop = store.onChange((s) => seen.push(s.offline));
    await store.update({ offline: true }, yes);
    stop();
    await store.update({ offline: false }, yes);
    expect(seen).toEqual([true]);
  });
});
