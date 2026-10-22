import { expect, test } from "@playwright/test";
import { collectCspViolations, launch, target, type Launched } from "./launch";

// CLAUDE.md "Electron security", checked against the running app. One app
// instance serves the whole file; tests that change state undo it.
test.describe.configure({ mode: "serial" });

let epoch: Launched;

test.beforeAll(async () => {
  epoch = await launch();
});

test.afterAll(async () => {
  await epoch.close();
});

/** Replaces shell.openExternal in main with a recorder; returns a reader. */
async function recordOpenExternal(): Promise<() => Promise<string[]>> {
  await epoch.app.evaluate(({ shell }) => {
    const opened: string[] = [];
    (globalThis as { __opened?: string[] }).__opened = opened;
    shell.openExternal = (url: string) => {
      opened.push(url);
      return Promise.resolve();
    };
  });
  return () =>
    epoch.app.evaluate(
      () => (globalThis as { __opened?: string[] }).__opened ?? [],
    );
}

test("the UI is served from the app scheme", () => {
  expect(epoch.page.url()).toBe("epoch://app/index.html");
});

test("the renderer has no Node.js access", async () => {
  const types = await epoch.page.evaluate(() => {
    const g = globalThis as Record<string, unknown>;
    return ["require", "process", "module", "Buffer", "global"].map(
      (name) => `${name}:${typeof g[name]}`,
    );
  });
  expect(types).toEqual([
    "require:undefined",
    "process:undefined",
    "module:undefined",
    "Buffer:undefined",
    "global:undefined",
  ]);
});

test("the window's webPreferences stay locked down", async () => {
  const prefs = await epoch.app.evaluate(({ BrowserWindow }) => {
    const [win] = BrowserWindow.getAllWindows();
    // Electron has no public getter for webPreferences. This internal method
    // returns the ones the renderer was created with; if it ever disappears,
    // the test fails loudly rather than passing vacuously.
    const contents = win?.webContents as unknown as
      { getLastWebPreferences(): Record<string, unknown> | null } | undefined;
    return contents?.getLastWebPreferences() ?? null;
  });
  expect(prefs).toMatchObject({
    contextIsolation: true,
    nodeIntegration: false,
    nodeIntegrationInWorker: false,
    nodeIntegrationInSubFrames: false,
    sandbox: true,
    webSecurity: true,
    allowRunningInsecureContent: false,
    webviewTag: false,
  });
});

test("every UI response carries the strict Content-Security-Policy", async () => {
  const csp = await epoch.page.evaluate(async () => {
    // eslint-disable-next-line no-restricted-globals -- runs in the renderer, reading the app's own origin
    const res = await fetch("/index.html");
    return res.headers.get("content-security-policy");
  });
  expect(csp).toMatch(/^default-src 'none'; script-src 'self';/);
});

test("loading the UI causes no CSP violations", async () => {
  const violations = collectCspViolations(epoch.page);
  await epoch.page.reload({ waitUntil: "load" });
  expect(violations).toEqual([]);
});

test("an injected inline script does not run", async () => {
  const violations = collectCspViolations(epoch.page);
  const ran = await epoch.page.evaluate(async () => {
    const script = document.createElement("script");
    script.textContent = "window.__injected = true";
    document.head.append(script);
    await new Promise((r) => setTimeout(r, 100));
    return (window as { __injected?: boolean }).__injected === true;
  });
  expect(ran).toBe(false);
  // Also shows that the collector the previous test relies on sees violations.
  // The header and the meta tag each enforce the policy, so each reports it.
  expect(violations.length).toBeGreaterThan(0);
  for (const v of violations) expect(v).toContain("script-src 'self'");
});

test("user data stays in the directory the launcher chose", async () => {
  const userData = await epoch.app.evaluate(({ app }) =>
    app.getPath("userData"),
  );
  expect(userData).toMatch(/epoch-e2e-[^/\\]+[/\\]user-data$/);
});

test("navigation away from the UI is blocked; allowlisted links open externally", async () => {
  const opened = await recordOpenExternal();
  for (const url of ["https://example.com/", "https://github.com/"]) {
    await epoch.page.evaluate((u) => {
      window.location.href = u;
    }, url);
  }
  await epoch.page.waitForTimeout(500);
  expect(epoch.page.url()).toBe("epoch://app/index.html");
  expect(await opened()).toEqual(["https://github.com/"]);
});

test("window.open is denied; allowlisted links open externally", async () => {
  const opened = await recordOpenExternal();
  const results = await epoch.page.evaluate(() =>
    ["https://example.com/", "https://github.com/", "epoch://app/"].map(
      (u) => window.open(u) === null,
    ),
  );
  await epoch.page.waitForTimeout(200);
  expect(results).toEqual([true, true, true]);
  expect(epoch.app.windows()).toHaveLength(1);
  expect(await opened()).toEqual(["https://github.com/"]);
});

test("requests outside the UI are cancelled, whoever makes them", async () => {
  const fromMain = await epoch.app.evaluate(async ({ BrowserWindow }) => {
    const probe = new BrowserWindow({ show: false });
    try {
      await probe.loadURL("https://example.com/");
      return "loaded";
    } catch (error) {
      return String(error);
    } finally {
      probe.destroy();
    }
  });
  expect(fromMain).toContain("ERR_BLOCKED_BY_CLIENT");

  const fromRenderer = await epoch.page.evaluate(async () => {
    try {
      // eslint-disable-next-line no-restricted-globals -- proves the renderer cannot reach the network
      await fetch("https://example.com/");
      return "fetched";
    } catch {
      return "refused";
    }
  });
  expect(fromRenderer).toBe("refused");
});

test("permission requests are denied", async () => {
  const notification = await epoch.page.evaluate(() =>
    Notification.requestPermission(),
  );
  expect(notification).toBe("denied");
});

test("a packaged app ignores ELECTRON_RENDERER_URL", async () => {
  test.skip(target !== "packaged", "only packaged builds must ignore it");
  const other = await launch({ ELECTRON_RENDERER_URL: "http://localhost:9/" });
  try {
    expect(other.page.url()).toBe("epoch://app/index.html");
  } finally {
    await other.close();
  }
});
