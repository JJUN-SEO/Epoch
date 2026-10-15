import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  _electron as electron,
  type ElectronApplication,
  type Page,
} from "@playwright/test";

const appDir = path.resolve(import.meta.dirname, "..");

/** "build": the electron-vite output run by the electron binary. "packaged": electron-builder --dir. */
export const target: "build" | "packaged" =
  process.env.EPOCH_E2E_TARGET === "packaged" ? "packaged" : "build";

/** The executable electron-builder --dir wrote under release/ for this OS. */
export function packagedExecutable(): string {
  const release = path.join(appDir, "release");
  const dirs = readdirSync(release, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name);
  const candidates =
    process.platform === "darwin"
      ? dirs
          .filter((d) => d.startsWith("mac"))
          .map((d) =>
            path.join(release, d, "Epoch.app", "Contents", "MacOS", "Epoch"),
          )
      : process.platform === "win32"
        ? dirs
            .filter((d) => d.endsWith("-unpacked"))
            .map((d) => path.join(release, d, "Epoch.exe"))
        : dirs
            .filter((d) => d.endsWith("-unpacked"))
            .map((d) => path.join(release, d, "epoch"));
  const [exe] = candidates;
  if (exe === undefined || candidates.length > 1) {
    throw new Error(
      `Expected one packaged app under ${release}, found: ${dirs.join(", ") || "nothing"}. Run pnpm --filter @epoch-dev/app package:dir first.`,
    );
  }
  return exe;
}

export interface Launched {
  readonly app: ElectronApplication;
  readonly page: Page;
  /** Holds this run's user-data and cache directories. */
  readonly home: string;
  close(): Promise<void>;
}

/**
 * Starts the app with a throwaway user-data and cache directory (or the given
 * one, to test what survives a restart), and waits for the first window to
 * finish loading.
 */
export async function launch(
  env: Readonly<Record<string, string>> = {},
  reuse?: { readonly home: string },
): Promise<Launched> {
  const home = reuse?.home ?? mkdtempSync(path.join(os.tmpdir(), "epoch-e2e-"));
  const options = {
    // Keep Chromium's OS-level sandbox on under Playwright (it adds
    // --no-sandbox on Linux otherwise); CI runs as a non-root user.
    chromiumSandbox: true,
    args: [`--user-data-dir=${path.join(home, "user-data")}`],
    env: {
      ...(process.env as Record<string, string>),
      EPOCH_CACHE_DIR: path.join(home, "cache"),
      ...env,
    },
  };
  const app =
    target === "packaged"
      ? await electron.launch({
          ...options,
          executablePath: packagedExecutable(),
        })
      : await electron.launch({ ...options, args: [appDir, ...options.args] });
  const page = await app.firstWindow();
  await page.waitForLoadState("load");
  return {
    app,
    page,
    home,
    async close() {
      await app.close();
      if (reuse === undefined) rmSync(home, { recursive: true, force: true });
    },
  };
}

/** Collects Content-Security-Policy violations the page reports from now on. */
export function collectCspViolations(page: Page): string[] {
  const violations: string[] = [];
  page.on("console", (message) => {
    if (/Content Security Policy/i.test(message.text())) {
      violations.push(message.text());
    }
  });
  return violations;
}
