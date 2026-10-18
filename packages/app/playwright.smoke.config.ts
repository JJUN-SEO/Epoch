import { defineConfig } from "@playwright/test";

// The installer smoke test (smoke/smoke.spec.ts): drives an installed Epoch,
// so it needs no build of the app. installers.yml runs it on fresh runners.
export default defineConfig({
  testDir: "smoke",
  outputDir: "test-results",
  timeout: 240_000,
  // A step that cannot happen fails with its own message, not the test's
  // timeout (actions wait forever by default).
  use: { actionTimeout: 30_000 },
  expect: { timeout: 30_000 },
  workers: 1,
  forbidOnly: process.env.CI !== undefined,
  reporter: process.env.CI === undefined ? "list" : [["list"], ["github"]],
});
