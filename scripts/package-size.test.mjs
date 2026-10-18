import assert from "node:assert/strict";
import { test } from "node:test";
import { mergeSizeReports } from "./package-size.mjs";

const reports = [
  "### macos-26\n\n| Installer | Size |\n| --- | --- |\n| `Epoch-mac-arm64.dmg` | 210.3 MB |\n",
  "### windows-2025\n\n| Installer | Size |\n| --- | --- |\n| `Epoch-win-x64-setup.exe` | 200.1 MB |\n",
  "### ubuntu-24.04\n\n| Installer | Size |\n| --- | --- |\n| `Epoch-linux-x64.AppImage` | 223.3 MB |\n| `Epoch-linux-x64.deb` | 192.5 MB |\n",
];
const provenance = {
  run: "https://github.com/JJUN-SEO/Epoch/actions/runs/39096906655",
  commit: "76375cfdafdf604e5d3afc8383c4bc921e0fa20f",
  electron: "43.7.7",
};

test("merges all four CI package sizes with their provenance", () => {
  const report = mergeSizeReports(reports, provenance);
  assert.match(
    report,
    /\| windows-2025 \| `Epoch-win-x64-setup.exe` \| 200.1 MB \|/,
  );
  assert.match(report, /39096906655/);
  assert.match(report, /76375cfdafdf604e5d3afc8383c4bc921e0fa20f/);
});

test("does not publish an incomplete size report", () => {
  assert.throws(
    () => mergeSizeReports(reports.slice(0, 2), provenance),
    /missing installer/,
  );
});
