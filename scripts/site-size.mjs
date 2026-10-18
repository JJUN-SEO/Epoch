// Gzip size budgets for the GitHub Pages build. The measured baseline was
// `vite build` on 2026-10-18, before the landing page and demo were deployed.
// Budgets are about 15% above that build and fail when a later change grows it.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { gzipSync } from "node:zlib";

const dir = process.argv[2] ?? "apps/site/dist";
const assets = path.join(dir, "assets");
const files = fs.readdirSync(assets);
const bytes = (file) => gzipSync(fs.readFileSync(file), { level: 9 }).length;
const chunk = (prefix, ext) => {
  const matches = files.filter((f) => f.startsWith(prefix) && f.endsWith(ext));
  assert.equal(matches.length, 1, `one ${prefix}*${ext} chunk expected`);
  return bytes(path.join(assets, matches[0]));
};

// Measured gzip baselines, in bytes: landing 133157 (including the screenshot), demo JS 287704,
// CSS 6594, zod data 64582, Flask data 12832, cli data 146470.
const measured = {
  landing: ["index.html", "site.css", "icon.svg", "demo.png"].reduce(
    (sum, file) => sum + bytes(path.join(dir, file)),
    0,
  ),
  app: chunk("demo-", ".js"),
  styles: chunk("demo-", ".css"),
  zod: chunk("zod.graph-", ".js"),
  flask: chunk("flask.graph-", ".js"),
  cli: chunk("cli.graph-", ".js"),
};
const limits = {
  landing: 154000,
  app: 331000,
  styles: 7600,
  zod: 74500,
  flask: 14800,
  cli: 169000,
};
for (const [name, size] of Object.entries(measured)) {
  process.stdout.write(`${name}: ${size} / ${limits[name]} gzip bytes\n`);
  assert.ok(size <= limits[name], `${name} exceeded its gzip budget`);
}
