import { defineConfig } from "@playwright/test";

// End-to-end tests drive the real Electron app: the electron-vite build by
// default, or the electron-builder --dir output with EPOCH_E2E_TARGET=packaged.
export default defineConfig({
  testDir: "e2e",
  outputDir: "test-results",
  timeout: 60_000,
  workers: 1,
  forbidOnly: process.env.CI !== undefined,
  reporter: process.env.CI === undefined ? "list" : [["list"], ["github"]],
});
