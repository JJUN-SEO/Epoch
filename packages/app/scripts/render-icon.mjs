// Renders build/icon.svg to build/icon.png (1024×1024, transparent corners)
// with Playwright's Chromium. The PNG is committed: electron-builder makes
// the macOS, Windows and Linux icons from it, so packaging needs no browser.
// Run after changing the SVG: `pnpm --filter @epoch-dev/app icon`
// (CHROMIUM_PATH picks a Chromium other than Playwright's own).
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { chromium } from "@playwright/test";

const dir = path.resolve(import.meta.dirname, "../build");
const svg = fs.readFileSync(path.join(dir, "icon.svg"), "utf8");
const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH || undefined,
});
try {
  const page = await browser.newPage({
    viewport: { width: 1024, height: 1024 },
    deviceScaleFactor: 1,
  });
  await page.setContent(
    `<!doctype html><style>html,body{margin:0;background:transparent}svg{display:block}</style>${svg}`,
  );
  await page.screenshot({
    path: path.join(dir, "icon.png"),
    omitBackground: true,
  });
} finally {
  await browser.close();
}
