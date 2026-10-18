// Record the shared App UI using the pinned zod graph in the static demo.
// Start `pnpm --filter @epoch-dev/site preview` after a site build, then run
// this script. The visitor's demo has no source code or model features.
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const recordings = path.join(root, ".cache", "demo-recordings");
fs.mkdirSync(recordings, { recursive: true });
const options = { headless: true };
if (process.env.EPOCH_BROWSER_CHANNEL === "chrome") options.channel = "chrome";
const browser = await chromium.launch(options);
const context = await browser.newContext({
  viewport: { width: 1440, height: 900 },
  deviceScaleFactor: 1,
  recordVideo: { dir: recordings, size: { width: 1440, height: 900 } },
});
const page = await context.newPage();
const url =
  process.env.EPOCH_SITE_DEMO_URL ??
  "http://127.0.0.1:4173/Epoch/demo.html?repo=zod";
await page.goto(url);
await page.getByTestId("graph-stats").waitFor();
await page.waitForTimeout(1800);
await page.screenshot({
  path: path.join(root, "apps", "site", "public", "demo.png"),
});
await page
  .getByTestId("findings-banner")
  .getByRole("button", { name: "Review" })
  .click();
await page.waitForTimeout(1800);
await page.getByRole("button", { name: "Graph", exact: true }).first().click();
await page.waitForTimeout(1000);
await page.getByText("rollup.config.js", { exact: true }).first().click();
await page.waitForTimeout(1800);
await context.close();
await browser.close();
process.stdout.write(`${await page.video().path()}\n`);
