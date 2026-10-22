import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { chromium, type Browser, type Page } from "@playwright/test";

/*
 * Drives an installed Epoch the way a user's machine runs it (ADR-018).
 * Installers ship with Node's inspector fuse off, so Playwright's Electron
 * launcher (which passes --inspect) cannot start them. Chromium's own
 * remote-debugging port still works: the app is spawned with it and driven
 * with connectOverCDP. Chromium's network log, started with the app, records
 * every request any part of it makes; it is complete only after a clean quit.
 */

export interface Seed {
  /** Written to user-data/settings.json (missing fields take defaults). */
  readonly settings?: Record<string, unknown>;
  /** Written to user-data/recent-projects.json; the Welcome screen lists them. */
  readonly recent?: readonly string[];
}

export interface Installed {
  readonly page: Page;
  readonly home: string;
  /** Quits through Chromium (Browser.close), as closing the app would. */
  quit(): Promise<void>;
  /** The URLs of every request in the network log; call after quit(). */
  urls(): string[];
  /** What the app printed, for failure messages. */
  output(): string;
}

const START_MS = 60_000;
const QUIT_MS = 15_000;

/** The exit code, or "timeout" if the process is still running after `ms`. */
function exitWithin(
  exited: Promise<number | null>,
  ms: number,
): Promise<number | null | "timeout"> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    exited,
    new Promise<"timeout">((resolve) => {
      timer = setTimeout(() => {
        resolve("timeout");
      }, ms);
    }),
  ]).finally(() => {
    clearTimeout(timer);
  });
}

function waitForDevTools(child: ChildProcess, output: () => string) {
  return new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(
        new Error(
          `no DevTools endpoint after ${String(START_MS)} ms:\n${output()}`,
        ),
      );
    }, START_MS);
    const look = () => {
      const m = /DevTools listening on (ws:\/\/\S+)/.exec(output());
      if (m?.[1]) {
        clearTimeout(timer);
        resolve(m[1]);
      }
    };
    child.stderr?.on("data", look);
    child.on("exit", (code, signal) => {
      clearTimeout(timer);
      reject(
        new Error(
          `the app exited (${String(code ?? signal)}) before it was ready:\n${output()}`,
        ),
      );
    });
  });
}

async function appPage(browser: Browser): Promise<Page> {
  const [context] = browser.contexts();
  if (!context) throw new Error("no browser context");
  const page =
    context.pages().find((p) => p.url().startsWith("epoch://")) ??
    (await context.waitForEvent("page", {
      predicate: (p) => p.url().startsWith("epoch://"),
      timeout: START_MS,
    }));
  await page.waitForLoadState("load");
  return page;
}

/** Starts the installed executable on a fresh home (user data, cache, data). */
export async function startInstalled(
  executable: string,
  seed: Seed = {},
  env: Readonly<Record<string, string>> = {},
): Promise<Installed> {
  const home = fs.realpathSync.native(
    fs.mkdtempSync(path.join(os.tmpdir(), "epoch-smoke-")),
  );
  const userData = path.join(home, "user-data");
  fs.mkdirSync(userData, { recursive: true });
  if (seed.settings)
    fs.writeFileSync(
      path.join(userData, "settings.json"),
      JSON.stringify(seed.settings),
    );
  if (seed.recent)
    fs.writeFileSync(
      path.join(userData, "recent-projects.json"),
      JSON.stringify({ version: 1, projects: seed.recent }),
    );
  const netlog = path.join(home, "netlog.json");

  let printed = "";
  const child = spawn(
    executable,
    [
      `--user-data-dir=${userData}`,
      "--remote-debugging-port=0",
      `--log-net-log=${netlog}`,
    ],
    {
      env: {
        ...process.env,
        EPOCH_CACHE_DIR: path.join(home, "cache"),
        EPOCH_DATA_DIR: path.join(home, "data"),
        ...env,
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  const keep = (chunk: Buffer) => {
    printed += chunk.toString("utf8");
  };
  child.stdout.on("data", keep);
  child.stderr.on("data", keep);
  const output = () => printed.split(/\r?\n/).slice(-60).join("\n");
  const exited = new Promise<number | null>((resolve) => {
    child.on("exit", (code) => {
      resolve(code);
    });
  });

  let browser: Browser;
  let page: Page;
  try {
    browser = await chromium.connectOverCDP(
      await waitForDevTools(child, output),
    );
    page = await appPage(browser);
  } catch (e) {
    child.kill("SIGKILL");
    throw e;
  }

  return {
    page,
    home,
    output,
    async quit() {
      const cdp = await browser.newBrowserCDPSession();
      // The connection closes as the app quits, so this never answers.
      void cdp.send("Browser.close").catch(() => undefined);
      let code = await exitWithin(exited, QUIT_MS);
      // If closing through Chromium left it running (macOS keeps an app
      // alive without windows), SIGTERM quits Electron cleanly on POSIX.
      if (code === "timeout" && process.platform !== "win32") {
        child.kill("SIGTERM");
        code = await exitWithin(exited, QUIT_MS);
      }
      if (code === "timeout") {
        child.kill("SIGKILL");
        throw new Error(
          `the app did not quit within ${String(QUIT_MS)} ms:\n${output()}`,
        );
      }
      if (code !== 0)
        throw new Error(`the app quit with ${String(code)}:\n${output()}`);
    },
    urls() {
      // JSON.parse fails on a log cut short, which would hide requests.
      const log = JSON.parse(fs.readFileSync(netlog, "utf8")) as {
        events?: { params?: { url?: unknown } }[];
      };
      const urls = new Set<string>();
      for (const e of log.events ?? [])
        if (typeof e.params?.url === "string") urls.add(e.params.url);
      return [...urls].sort();
    },
  };
}
