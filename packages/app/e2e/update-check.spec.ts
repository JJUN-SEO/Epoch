import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { launch, type Launched } from "./launch";

// The daily update check (ADR-018), against a stub of GitHub on main's
// egress session (attached as the app creates it). Every other e2e test
// starts with update checks off (launch.ts); these turn them on.
test.describe.configure({ mode: "serial" });

const fixtures = path.resolve(import.meta.dirname, "../../../fixtures");
const LATEST = "https://api.github.com/repos/JJUN-SEO/Epoch/releases/latest";
/** Past main's first check, 10 s after the window opens. */
const PAST_FIRST_CHECK_MS = 12_000;

interface Seen {
  readonly method: string;
  readonly url: string;
  readonly userAgent: string | null;
  readonly cookie: string | null;
  readonly apiVersion: string | null;
}
type Answer = { readonly tag: string } | { readonly redirect: true };

const homes: string[] = [];
function home(settings: Record<string, unknown>): string {
  const dir = fs.realpathSync.native(
    fs.mkdtempSync(path.join(os.tmpdir(), "epoch-e2e-update-")),
  );
  homes.push(dir);
  fs.mkdirSync(path.join(dir, "user-data"), { recursive: true });
  fs.writeFileSync(
    path.join(dir, "user-data", "settings.json"),
    JSON.stringify(settings),
  );
  return dir;
}

test.afterAll(() => {
  for (const dir of homes) fs.rmSync(dir, { recursive: true, force: true });
});

/** Answers GitHub on main's egress session, recording each request. */
async function stubGitHub(epoch: Launched, answer: Answer): Promise<void> {
  await epoch.app.evaluate(({ app, session, shell }, a) => {
    const g = globalThis as { seen?: Seen[]; opened?: string[] };
    const seen: Seen[] = [];
    const opened: string[] = [];
    g.seen = seen;
    g.opened = opened;
    shell.openExternal = (url: string) => {
      opened.push(url);
      return Promise.resolve();
    };
    app.on("session-created", (ses) => {
      if (ses === session.defaultSession) return;
      ses.protocol.handle("https", (req) => {
        seen.push({
          method: req.method,
          url: req.url,
          userAgent: req.headers.get("user-agent"),
          cookie: req.headers.get("cookie"),
          apiVersion: req.headers.get("x-github-api-version"),
        });
        if ("redirect" in a)
          return new Response(null, {
            status: 301,
            headers: {
              location: "https://api.github.com/repositories/1/releases/latest",
            },
          });
        return new Response(
          JSON.stringify({ tag_name: a.tag, draft: false, prerelease: false }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      });
    });
  }, answer);
}

const seen = (epoch: Launched) =>
  epoch.app.evaluate(() => (globalThis as { seen?: Seen[] }).seen ?? []);
const opened = (epoch: Launched) =>
  epoch.app.evaluate(() => (globalThis as { opened?: string[] }).opened ?? []);
const notice = (page: Page) => page.getByTestId("update-notice");

async function openSmallProject(epoch: Launched): Promise<void> {
  const dir = fs.realpathSync.native(
    fs.mkdtempSync(path.join(os.tmpdir(), "epoch-e2e-update-project-")),
  );
  homes.push(dir);
  fs.cpSync(path.join(fixtures, "typescript/conformance/relative"), dir, {
    recursive: true,
  });
  await epoch.app.evaluate(({ dialog }, f) => {
    dialog.showOpenDialog = () =>
      Promise.resolve({ canceled: false, filePaths: [f] });
  }, dir);
  await epoch.page.getByRole("button", { name: "Open Project…" }).click();
  await expect(epoch.page.getByTestId("graph-stats")).toHaveText(
    "2 files · 1 edges",
  );
}

function urlsIn(file: string): string[] {
  const log = JSON.parse(fs.readFileSync(file, "utf8")) as {
    events?: { params?: { url?: unknown } }[];
  };
  const urls = new Set<string>();
  for (const e of log.events ?? [])
    if (typeof e.params?.url === "string") urls.add(e.params.url);
  return [...urls].sort();
}

test("off (as every other test starts): no request, from launch to quit", async () => {
  const dir = home({ updateChecks: false });
  const netlog = path.join(dir, "netlog.json");
  const epoch = await launch({}, { home: dir }, [`--log-net-log=${netlog}`]);
  await stubGitHub(epoch, { tag: "v99.0.0" });
  await openSmallProject(epoch);
  await epoch.page.waitForTimeout(PAST_FIRST_CHECK_MS);
  expect(await seen(epoch)).toEqual([]);
  await expect(notice(epoch.page)).toHaveCount(0);
  await epoch.quit();
  expect(urlsIn(netlog)).toEqual([]);
});

test("offline mode with update checks on: no request", async () => {
  const dir = home({ offline: true, updateChecks: true });
  const epoch = await launch({}, { home: dir });
  try {
    await stubGitHub(epoch, { tag: "v99.0.0" });
    await epoch.page.waitForTimeout(PAST_FIRST_CHECK_MS);
    expect(await seen(epoch)).toEqual([]);
    await expect(notice(epoch.page)).toHaveCount(0);
  } finally {
    await epoch.quit();
  }
});

test("turned on: one GET to the latest-release URL, and a notice that links to the release", async () => {
  const dir = home({ updateChecks: false });
  const epoch = await launch({}, { home: dir });
  try {
    await stubGitHub(epoch, { tag: "v99.0.0" });
    await epoch.page.evaluate(() =>
      window.epoch.updateSettings({ updateChecks: true }),
    );
    await expect(notice(epoch.page)).toContainText("Epoch 99.0.0 is available");
    expect(await seen(epoch)).toEqual([
      {
        method: "GET",
        url: LATEST,
        userAgent: "Epoch",
        cookie: null,
        apiVersion: "2026-03-10",
      },
    ]);
    await notice(epoch.page)
      .getByRole("link", { name: "See the release" })
      .click();
    await expect
      .poll(() => opened(epoch))
      .toEqual(["https://github.com/JJUN-SEO/Epoch/releases/tag/v99.0.0"]);
    await notice(epoch.page)
      .getByRole("button", { name: "Hide until Epoch restarts" })
      .click();
    await expect(notice(epoch.page)).toHaveCount(0);
  } finally {
    await epoch.quit();
  }

  // Started again within the day: the notice is back, without a request.
  const again = await launch({}, { home: dir });
  try {
    await stubGitHub(again, { tag: "v99.0.0" });
    await expect(notice(again.page)).toContainText("Epoch 99.0.0 is available");
    await again.page.waitForTimeout(PAST_FIRST_CHECK_MS);
    expect(await seen(again)).toEqual([]);
  } finally {
    await again.quit();
  }
});

test("the same version: no notice", async () => {
  const dir = home({ updateChecks: false });
  const epoch = await launch({}, { home: dir });
  try {
    const version = await epoch.app.evaluate(({ app }) => app.getVersion());
    await stubGitHub(epoch, { tag: `v${version}` });
    await epoch.page.evaluate(() =>
      window.epoch.updateSettings({ updateChecks: true }),
    );
    await expect.poll(async () => (await seen(epoch)).length).toBe(1);
    await epoch.page.waitForTimeout(1_000);
    await expect(notice(epoch.page)).toHaveCount(0);
  } finally {
    await epoch.quit();
  }
});

test("a redirect is not followed: one request, no notice", async () => {
  const dir = home({ updateChecks: false });
  const epoch = await launch({}, { home: dir });
  try {
    await stubGitHub(epoch, { redirect: true });
    await epoch.page.evaluate(() =>
      window.epoch.updateSettings({ updateChecks: true }),
    );
    await expect.poll(async () => (await seen(epoch)).length).toBe(1);
    await epoch.page.waitForTimeout(1_000);
    expect(await seen(epoch)).toHaveLength(1);
    await expect(notice(epoch.page)).toHaveCount(0);
  } finally {
    await epoch.quit();
  }
});
