import { defineConfig, devices } from "@playwright/test";

// The built site, served under /Epoch/ as GitHub Pages serves it.
// CHROMIUM_PATH picks a Chromium other than Playwright's own.
export default defineConfig({
  testDir: "./e2e",
  timeout: 30_000,
  retries: process.env.CI ? 1 : 0,
  forbidOnly: !!process.env.CI,
  use: {
    ...devices["Desktop Chrome"],
    ...(process.env.EPOCH_SITE_BROWSER_CHANNEL === "chrome"
      ? { channel: "chrome" }
      : {}),
    ...(process.env.CHROMIUM_PATH
      ? { launchOptions: { executablePath: process.env.CHROMIUM_PATH } }
      : {}),
    baseURL: "http://127.0.0.1:4173/Epoch/",
  },
  webServer: {
    command: "pnpm preview --strictPort",
    url: "http://127.0.0.1:4173/Epoch/",
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
  },
});
