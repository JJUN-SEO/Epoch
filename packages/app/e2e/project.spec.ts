import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, test } from "@playwright/test";
import type { Graph, Progress, ProjectInfo } from "@epoch-dev/core";
import { launch, type Launched } from "./launch";

// Opening a project end to end: dialog -> granted root -> analysis host ->
// graph, plus the IPC and path rules from CLAUDE.md "Electron security".
test.describe.configure({ mode: "serial" });

const fixtures = path.resolve(import.meta.dirname, "../../../fixtures");
const temps: string[] = [];

/** A fresh temporary folder (real path, so it matches what main reports). */
function tempDir(): string {
  const dir = fs.realpathSync.native(
    fs.mkdtempSync(path.join(os.tmpdir(), "epoch-e2e-project-")),
  );
  temps.push(dir);
  return dir;
}

/** Copies a fixture to a temp folder, so a failing test can't touch the repo. */
function copyFixture(rel: string): string {
  const dir = tempDir();
  fs.cpSync(path.join(fixtures, rel), dir, { recursive: true });
  return dir;
}

/** Every file under `dir` with a hash of its bytes. */
function snapshot(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const rel of fs.readdirSync(dir, {
    recursive: true,
    encoding: "utf8",
  })) {
    const abs = path.join(dir, rel);
    if (fs.lstatSync(abs).isFile()) {
      out[rel] = createHash("sha256")
        .update(fs.readFileSync(abs))
        .digest("hex");
    }
  }
  return out;
}

let epoch: Launched;

test.beforeAll(async () => {
  epoch = await launch();
});

test.afterAll(async () => {
  await epoch.close();
  for (const dir of temps) fs.rmSync(dir, { recursive: true, force: true });
});

/** Makes main's native folder dialog return `folder`. */
async function answerDialogWith(folder: string): Promise<void> {
  await epoch.app.evaluate(({ dialog }, f) => {
    dialog.showOpenDialog = () =>
      Promise.resolve({ canceled: false, filePaths: [f] });
  }, folder);
}

/** Opens `folder` through the dialog and returns its info, graph and progress. */
async function openThroughDialog(folder: string): Promise<{
  info: ProjectInfo | null;
  graph: Graph;
  progress: Progress[];
}> {
  await answerDialogWith(folder);
  return epoch.page.evaluate(async () => {
    const progress: Progress[] = [];
    const stop = window.epoch.onProgress((p) => progress.push(p));
    const info = await window.epoch.chooseProject();
    const graph = await window.epoch.getGraph();
    stop();
    return { info, graph, progress };
  });
}

test("the bridge exposes only its named functions", async () => {
  const surface = await epoch.page.evaluate(() => ({
    keys: Object.keys(window.epoch).sort(),
    ipcRenderer: typeof (window as { ipcRenderer?: unknown }).ipcRenderer,
    electron: typeof (window as { electron?: unknown }).electron,
  }));
  expect(surface).toEqual({
    keys: [
      "chooseProject",
      "getGraph",
      "onMenuCommand",
      "onProgress",
      "onProjectOpened",
      "openDroppedFolder",
      "openProject",
      "recentProjects",
      "showAppMenu",
    ],
    ipcRenderer: "undefined",
    electron: "undefined",
  });
});

test("a folder chosen in the dialog is analyzed in the host, with progress", async () => {
  const folder = copyFixture("typescript/conformance/relative");
  const { info, graph, progress } = await openThroughDialog(folder);
  expect(info).toEqual({ root: folder, name: path.basename(folder) });
  expect(graph.nodes.map((n) => n.id)).toEqual(["src/a.ts", "src/b.ts"]);
  expect(graph.edges).toMatchObject([
    { source: "src/a.ts", target: "src/b.ts", kind: "import" },
  ]);
  expect(progress.map((p) => p.stage)).toContain("parse");
  expect(progress.at(-1)?.stage).toBe("done");

  const hosts = await epoch.app.evaluate(({ app }) =>
    app
      .getAppMetrics()
      .filter((m) => m.type === "Utility" && m.name === "Epoch analysis host")
      .map((m) => m.pid),
  );
  expect(hosts).toHaveLength(1);
});

test("a recent project reopens; a folder never granted is refused", async () => {
  const granted = copyFixture("typescript/conformance/relative");
  await openThroughDialog(granted);
  const result = await epoch.page.evaluate(
    async ({ granted, other }) => {
      const recent = await window.epoch.recentProjects();
      const reopened = await window.epoch.openProject(granted);
      const refused = await window.epoch.openProject(other).then(
        () => "opened",
        (e: unknown) => String(e),
      );
      return { recent, reopened, refused };
    },
    { granted, other: tempDir() },
  );
  expect(result.recent[0]).toBe(granted);
  expect(result.reopened.root).toBe(granted);
  expect(result.refused).toContain("Epoch opens only folders chosen");
});

test("a symlink to a folder never granted is refused", async () => {
  test.skip(
    process.platform === "win32",
    "symlinks need extra rights on Windows",
  );
  const secret = tempDir();
  const link = path.join(tempDir(), "looks-innocent");
  fs.symlinkSync(secret, link, "dir");
  const refused = await epoch.page.evaluate(
    (p) =>
      window.epoch.openProject(p).then(
        () => "opened",
        (e: unknown) => String(e),
      ),
    link,
  );
  expect(refused).toContain("Epoch opens only folders chosen");
});

test("invalid payloads are rejected", async () => {
  const errors = await epoch.page.evaluate(async () => {
    // Bypass the bridge's types to send what a compromised page could.
    const bridge = window.epoch as unknown as {
      openProject(...args: unknown[]): Promise<unknown>;
    };
    const attempts = [
      bridge.openProject(42),
      bridge.openProject("relative/folder"),
      bridge.openProject(),
      bridge.openProject("/a", "/b"),
    ];
    return Promise.all(
      attempts.map((a) =>
        a.then(
          () => "accepted",
          (e: unknown) => String(e),
        ),
      ),
    );
  });
  const [number, relative, missing, extra] = errors;
  for (const e of [number, relative, missing]) {
    expect(e).toContain("invalid payload");
  }
  // The preload forwards only the first argument, so main sees "/a" alone,
  // which was never granted.
  expect(extra).toContain("Epoch opens only folders chosen");
});

test("the app-menu channel takes only a window position", async () => {
  const errors = await epoch.page.evaluate(async () => {
    const bridge = window.epoch as unknown as {
      showAppMenu(...args: unknown[]): Promise<unknown>;
    };
    const attempts = [
      bridge.showAppMenu("10", 40),
      bridge.showAppMenu(-1, 40),
      bridge.showAppMenu(1.5, 40),
      bridge.showAppMenu(),
    ];
    return Promise.all(
      attempts.map((a) =>
        a.then(
          () => "accepted",
          (e: unknown) => String(e),
        ),
      ),
    );
  });
  for (const e of errors) expect(e).toContain("invalid payload");

  // A valid position pops up the application menu there. The real popup is
  // stubbed: on macOS it would block until dismissed.
  await epoch.app.evaluate(({ Menu }) => {
    const g = globalThis as { epochPopups?: unknown[]; epochMenu?: unknown };
    g.epochPopups = [];
    g.epochMenu = Menu.getApplicationMenu.bind(Menu);
    Menu.getApplicationMenu = () =>
      ({
        popup: (o: { x: number; y: number }) => {
          g.epochPopups?.push({ x: o.x, y: o.y });
        },
      }) as unknown as ReturnType<typeof Menu.getApplicationMenu>;
  });
  try {
    await epoch.page.evaluate(() => window.epoch.showAppMenu(12, 40));
    const popups = await epoch.app.evaluate(
      () => (globalThis as { epochPopups?: unknown[] }).epochPopups,
    );
    expect(popups).toEqual([{ x: 12, y: 40 }]);
  } finally {
    await epoch.app.evaluate(({ Menu }) => {
      const g = globalThis as { epochMenu?: typeof Menu.getApplicationMenu };
      if (g.epochMenu) Menu.getApplicationMenu = g.epochMenu;
    });
  }
});

test("a File the page made itself carries no path and is refused", async () => {
  const refused = await epoch.page.evaluate(() =>
    window.epoch.openDroppedFolder(new File(["x"], "fake-folder")).then(
      () => "opened",
      (e: unknown) => String(e),
    ),
  );
  expect(refused).toContain("invalid payload");
});

test("analyzing a hostile fixture executes nothing and changes nothing", async () => {
  const folder = copyFixture("typescript/safety");
  const before = snapshot(folder);
  const { graph } = await openThroughDialog(folder);
  expect(graph.nodes.map((n) => n.id)).toContain("src/index.ts");
  expect(fs.existsSync(path.join(folder, "PWNED"))).toBe(false);
  expect(snapshot(folder)).toEqual(before);
});

test("a symlink inside the project that points outside it is never read", async () => {
  test.skip(
    process.platform === "win32",
    "symlinks need extra rights on Windows",
  );
  const outside = tempDir();
  fs.writeFileSync(
    path.join(outside, "secret.ts"),
    "export const SECRET_OUTSIDE_TOKEN = 1;\n",
  );
  const project = tempDir();
  fs.mkdirSync(path.join(project, "src"));
  fs.writeFileSync(
    path.join(project, "src", "index.ts"),
    'import { SECRET_OUTSIDE_TOKEN } from "./leak";\nexport const x = SECRET_OUTSIDE_TOKEN;\n',
  );
  fs.symlinkSync(
    path.join(outside, "secret.ts"),
    path.join(project, "src", "leak.ts"),
  );

  const { graph } = await openThroughDialog(project);
  expect(graph.nodes.map((n) => n.id)).toEqual(["src/index.ts"]);
  expect(graph.unresolved).toMatchObject([
    { from: "src/index.ts", specifier: "./leak", reason: "not-found" },
  ]);
  expect(JSON.stringify(graph)).not.toContain("SECRET_OUTSIDE_TOKEN");
});

test("a project large enough for the worker pool is analyzed in it", async () => {
  // 300 cache misses exceed the pool's DEFAULT_MIN_BATCH (256), so the host's
  // parse workers run, loaded from the app bundle (inside asar when packaged).
  const project = tempDir();
  const count = 300;
  fs.mkdirSync(path.join(project, "src"));
  for (let i = 0; i < count; i++) {
    const next =
      i + 1 < count
        ? `import { v${String(i + 1)} } from "./m${String(i + 1)}";\n`
        : "";
    fs.writeFileSync(
      path.join(project, "src", `m${String(i)}.ts`),
      `${next}export const v${String(i)} = ${String(i)};\n`,
    );
  }
  const { graph } = await openThroughDialog(project);
  expect(graph.nodes).toHaveLength(count);
  expect(graph.edges).toHaveLength(count - 1);
  expect(graph.edges[0]).toMatchObject({
    source: "src/m0.ts",
    target: "src/m1.ts",
    kind: "import",
  });
});

test("a Python project is analyzed, with barrel tracing through __init__.py", async () => {
  const folder = copyFixture("python/conformance/init-barrel");
  const { graph } = await openThroughDialog(folder);
  expect(graph.nodes.map((n) => [n.id, n.language])).toEqual([
    ["app.py", "python"],
    ["pkg/__init__.py", "python"],
    ["pkg/core.py", "python"],
  ]);
  expect(graph.edges).toContainEqual(
    expect.objectContaining({
      source: "app.py",
      target: "pkg/core.py",
      kind: "import",
      evidence: ["via barrel pkg/__init__.py"],
    }),
  );
});
