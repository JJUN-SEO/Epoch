import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, test } from "@playwright/test";
import { launch } from "./launch";

// CLAUDE.md "Privacy and data flow": with no keys configured (and nothing
// else turned on), Epoch makes no network requests, from launch to quit.
// Chromium's network log, started with the app, records every request any
// session or Chromium itself makes through the network stack; offline.spec.ts
// shows the log sees one when it happens. Found by the M8 installer spike:
// Chromium's spellchecker fetched a dictionary from Google at startup.

const fixtures = path.resolve(import.meta.dirname, "../../../fixtures");

test("from launch to quit, with no keys, the app makes no request", async () => {
  const home = fs.realpathSync.native(
    fs.mkdtempSync(path.join(os.tmpdir(), "epoch-e2e-quiet-")),
  );
  const project = path.join(home, "project");
  fs.cpSync(path.join(fixtures, "typescript/conformance/relative"), project, {
    recursive: true,
  });
  const netlog = path.join(home, "netlog.json");
  try {
    const epoch = await launch({}, { home }, [`--log-net-log=${netlog}`]);
    await epoch.app.evaluate(({ dialog }, f) => {
      dialog.showOpenDialog = () =>
        Promise.resolve({ canceled: false, filePaths: [f] });
    }, project);
    await epoch.page.getByRole("button", { name: "Open Project…" }).click();
    await expect(epoch.page.getByTestId("graph-stats")).toHaveText(
      "2 files · 1 edges",
    );
    // Text fields (Settings, the palette) are where a spellchecker would
    // start; give background work a moment before quitting.
    await epoch.page.getByRole("button", { name: "Settings" }).click();
    await expect(
      epoch.page.getByRole("dialog", { name: "Settings" }),
    ).toBeVisible();
    await epoch.page.keyboard.press("Escape");
    await epoch.page.waitForTimeout(2_000);
    await epoch.quit();

    // The log is complete only after a clean quit (it ends with "]}").
    const text = fs.readFileSync(netlog, "utf8");
    const log = JSON.parse(text) as {
      events?: { params?: { url?: unknown } }[];
    };
    expect(log.events?.length ?? 0).toBeGreaterThan(0);
    const urls = new Set<string>();
    for (const e of log.events ?? [])
      if (typeof e.params?.url === "string") urls.add(e.params.url);
    expect([...urls]).toEqual([]);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});
