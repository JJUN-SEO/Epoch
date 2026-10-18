import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  timeout: 30_000,
  retries: process.env.CI ? 1 : 0,
  use: {
    ...devices["Desktop Chrome"],
    ...(process.env.EPOCH_SITE_BROWSER_CHANNEL === "chrome"
      ? { channel: "chrome" }
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
