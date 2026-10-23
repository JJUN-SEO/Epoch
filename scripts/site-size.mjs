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
// 3D view 139841, 2D layout worker 177617, 3D layout worker 8761, CSS 6594,
// zod data 64582, Flask data 12832, cli data 146470. Re-measured 2026-10-22,
// after the attribution bar named the copyright and the screenshot became a
// 256-colour PNG (apps/site/scripts/record-demo.mjs): landing 79641, demo JS
// 287482, CSS 6619; the landing budget follows it. With the landing CSS and
// screenshot hashed by Vite and the screenshot re-recorded: landing 79236;
// re-recorded after the demo data moved to adapter version 9: 72707.
// The landing page's stylesheet and screenshot go through Vite (hashed
// names, so a new deploy never meets an old cached copy); index.html names them.
const landingAssets = [
  ...fs
    .readFileSync(path.join(dir, "index.html"), "utf8")
    .matchAll(/(?:href|src)="\/Epoch\/(assets\/[^"]+\.(?:css|png))"/g),
].map((m) => m[1]);
assert.equal(landingAssets.length, 2, "the landing CSS and screenshot");
const measured = {
  landing: ["index.html", "icon.svg", ...landingAssets].reduce(
    (sum, file) => sum + bytes(path.join(dir, file)),
    0,
  ),
  app: chunk("demo-", ".js"),
  graph3d: chunk("Graph3DView-", ".js"),
  layout2d: chunk("layout.worker-", ".js"),
  layout3d: chunk("layout3d.worker-", ".js"),
  styles: chunk("demo-", ".css"),
  zod: chunk("zod.graph-", ".js"),
  flask: chunk("flask.graph-", ".js"),
  cli: chunk("cli.graph-", ".js"),
};
const limits = {
  landing: 91600,
  app: 331000,
  graph3d: 161000,
  layout2d: 205000,
  layout3d: 10100,
  styles: 7600,
  zod: 74500,
  flask: 14800,
  cli: 169000,
};
for (const [name, size] of Object.entries(measured)) {
  process.stdout.write(`${name}: ${size} / ${limits[name]} gzip bytes\n`);
  assert.ok(size <= limits[name], `${name} exceeded its gzip budget`);
}
