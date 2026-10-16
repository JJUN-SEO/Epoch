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

/** The packaged app's resources folder (next to app.asar). */
export function packagedResources(): string {
  const exe = packagedExecutable();
  return process.platform === "darwin"
    ? path.resolve(path.dirname(exe), "../Resources")
    : path.join(path.dirname(exe), "resources");
}

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
  /** Holds this run's user-data, cache and data (dismissals) directories. */
  readonly home: string;
  /** Quits the app, keeping `home` (to launch again on it). */
  quit(): Promise<void>;
  /** Quits the app and removes `home` unless it was reused. */
  close(): Promise<void>;
}

/*
 * Launching and quitting get their own deadlines, well inside the test
 * timeout, so a hang fails naming the step and showing what the app last
 * wrote, instead of a bare test timeout (CI run 37: a test and the worker
 * teardown each waited 60 s on macOS with no clue where). A hung app is
 * killed so it cannot stall the rest of the run.
 */
const LAUNCH_MS = 30_000;
const QUIT_MS = 20_000;
const OUTPUT_LINES = 40;

/** Keeps the last lines the app wrote to stdout and stderr. */
function recordOutput(app: ElectronApplication): () => string {
  const lines: string[] = [];
  const keep = (chunk: Buffer) => {
    lines.push(...chunk.toString("utf8").split(/\r?\n/).filter(Boolean));
    lines.splice(0, Math.max(0, lines.length - OUTPUT_LINES));
  };
  const proc = app.process();
  proc.stdout?.on("data", keep);
  proc.stderr?.on("data", keep);
  return () => (lines.length === 0 ? "(nothing)" : lines.join("\n"));
}

/** Resolves as `step` does, or fails after `ms`, killing the app. */
async function within<T>(
  app: ElectronApplication,
  output: () => string,
  what: string,
  ms: number,
  step: Promise<T>,
): Promise<T> {
  step.catch(() => undefined); // still pending when the deadline wins
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      app.process().kill("SIGKILL");
      reject(
        new Error(
          `${what} took longer than ${String(ms / 1000)} s; the app was killed. Its last output:\n${output()}`,
        ),
      );
    }, ms);
  });
  try {
    return await Promise.race([step, deadline]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Starts the app with a throwaway user-data and cache directory (or the given
 * one, to test what survives a restart), and waits for the first window to
 * finish loading.
 */
export async function launch(
  env: Readonly<Record<string, string>> = {},
  reuse?: { readonly home: string },
  chromiumArgs: readonly string[] = [],
): Promise<Launched> {
  const home = reuse?.home ?? mkdtempSync(path.join(os.tmpdir(), "epoch-e2e-"));
  const options = {
    // Keep Chromium's OS-level sandbox on under Playwright (it adds
    // --no-sandbox on Linux otherwise); CI runs as a non-root user.
    chromiumSandbox: true,
    args: [`--user-data-dir=${path.join(home, "user-data")}`, ...chromiumArgs],
    env: {
      ...(process.env as Record<string, string>),
      EPOCH_CACHE_DIR: path.join(home, "cache"),
      EPOCH_DATA_DIR: path.join(home, "data"),
      // The local embedding model adds similarity hints in a second pass;
      // tests that want it (similarity.spec.ts) turn it back on.
      EPOCH_EMBEDDING_MODEL: "off",
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
  const output = recordOutput(app);
  const page = await within(
    app,
    output,
    "Opening the first window",
    LAUNCH_MS,
    app.firstWindow().then(async (p) => {
      await p.waitForLoadState("load");
      return p;
    }),
  );
  const quit = () => within(app, output, "Quitting", QUIT_MS, app.close());
  return {
    app,
    page,
    home,
    quit,
    async close() {
      await quit();
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
