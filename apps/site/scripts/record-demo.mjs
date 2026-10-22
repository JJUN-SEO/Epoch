// Records the README's demo: the shared App UI over the pinned zod graph in
// the static demo (which has no source code or model features). Writes the
// landing page's screenshot, apps/site/src/demo.png (as a 256-colour PNG,
// with ffmpeg, which make-gif.mjs needs too), and prints the path of a WebM
// for scripts/make-gif.mjs. Not run in CI.
//
// Usage, from the repository root, after a site build:
//   pnpm --filter @epoch-dev/site preview
//   node apps/site/scripts/record-demo.mjs
//   node scripts/make-gif.mjs <the printed .webm>
// CHROMIUM_PATH picks a Chromium other than Playwright's own.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";

const site = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const root = path.dirname(path.dirname(site));
const recordings = path.join(root, ".cache", "demo-recordings");
fs.mkdirSync(recordings, { recursive: true });
const options = { headless: true };
if (process.env.CHROMIUM_PATH)
  options.executablePath = process.env.CHROMIUM_PATH;
else if (process.env.EPOCH_BROWSER_CHANNEL === "chrome")
  options.channel = "chrome";
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
const screenshot = path.join(recordings, "demo.png");
await page.screenshot({ path: screenshot });
execFileSync("ffmpeg", [
  "-v",
  "error",
  "-y",
  "-i",
  screenshot,
  "-vf",
  "split[a][b];[a]palettegen=max_colors=256:stats_mode=full[p];[b][p]paletteuse=dither=none",
  "-pix_fmt",
  "pal8",
  path.join(site, "src", "demo.png"),
]);
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
