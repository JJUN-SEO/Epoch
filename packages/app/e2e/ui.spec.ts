import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { collectCspViolations, launch, type Launched } from "./launch";

// PLAN.md M3 acceptance: open a fixture folder, the graph renders, clicking a
// node shows its details. Plus the start screen, search, folders, the menu,
// and what survives a restart.
test.describe.configure({ mode: "serial" });

const fixtures = path.resolve(import.meta.dirname, "../../../fixtures");
const temps: string[] = [];

function tempDir(): string {
  const dir = fs.realpathSync.native(
    fs.mkdtempSync(path.join(os.tmpdir(), "epoch-e2e-ui-")),
  );
  temps.push(dir);
  return dir;
}

/** A project with `files` (relative path -> content). */
function project(files: Readonly<Record<string, string>>): string {
  const dir = tempDir();
  for (const [rel, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), content);
  }
  return dir;
}

let epoch: Launched;
let violations: string[];

test.beforeAll(async () => {
  epoch = await launch();
  violations = collectCspViolations(epoch.page);
});

test.afterAll(async () => {
  await epoch.close();
  for (const dir of temps) fs.rmSync(dir, { recursive: true, force: true });
});

async function answerDialogWith(folder: string): Promise<void> {
  await epoch.app.evaluate(({ dialog }, f) => {
    dialog.showOpenDialog = () =>
      Promise.resolve({ canceled: false, filePaths: [f] });
  }, folder);
}

/** Waits until the graph view has laid out `count` times in total. */
async function laidOut(page: Page, count = 1): Promise<void> {
  await expect
    .poll(async () =>
      Number(
        await page.getByTestId("graph-canvas").getAttribute("data-layouts"),
      ),
    )
    .toBeGreaterThanOrEqual(count);
}

/** Selects a node through the keyboard-accessible node list. */
async function selectNode(page: Page, id: string): Promise<void> {
  const button = page.locator(`button[data-node-id="${id}"]`);
  await button.focus();
  await button.press("Enter");
}

const details = (page: Page) => page.getByTestId("details");
const detailsTitle = (page: Page) =>
  details(page).getByRole("heading", { level: 2 });

test("the start screen states the privacy model", async () => {
  const note = epoch.page.getByRole("complementary", { name: "Privacy" });
  await expect(note).toContainText("Your code stays on this computer");
  await expect(note).toContainText("never runs its code");
  await expect(
    epoch.page.getByRole("button", { name: "Open Project…" }),
  ).toBeVisible();
});

test("a folder that cannot be opened reports why on the start screen", async () => {
  const file = path.join(tempDir(), "not-a-folder.txt");
  fs.writeFileSync(file, "x");
  await answerDialogWith(file);
  await epoch.page.getByRole("button", { name: "Open Project…" }).click();
  await expect(epoch.page.getByRole("alert")).toHaveText("Not a folder.");
});

test("opening a fixture renders its graph", async () => {
  await answerDialogWith(
    path.join(fixtures, "typescript", "conformance", "relative"),
  );
  await epoch.page.getByRole("button", { name: "Open Project…" }).click();
  await laidOut(epoch.page);
  await expect(epoch.page.getByTestId("graph-stats")).toHaveText(
    "2 files · 1 edges",
  );
  await expect(epoch.page.locator("button[data-node-id]")).toHaveCount(3);
});

test("selecting a node shows its details, and links lead to its neighbors", async () => {
  await selectNode(epoch.page, "src/a.ts");
  await expect(detailsTitle(epoch.page)).toHaveText("src/a.ts");
  await expect(details(epoch.page)).toContainText("Imports (1)");
  await details(epoch.page).getByRole("button", { name: "src/b.ts" }).click();
  await expect(detailsTitle(epoch.page)).toHaveText("src/b.ts");
  await expect(details(epoch.page)).toContainText("Imported by (1)");
});

test("the command palette finds a file and shows it", async () => {
  await epoch.page.keyboard.press("ControlOrMeta+K");
  const palette = epoch.page.getByRole("dialog", { name: "Command palette" });
  await palette
    .getByRole("combobox", { name: "Search files and commands" })
    .fill("A.TS");
  await palette.getByRole("option", { name: "src/a.ts" }).click();
  await expect(palette).toHaveCount(0);
  await expect(detailsTitle(epoch.page)).toHaveText("src/a.ts");
});

test("the command palette runs commands from the keyboard", async () => {
  await expect(
    epoch.page.getByRole("navigation", { name: "Sidebar" }),
  ).toBeVisible();
  await epoch.page
    .getByRole("button", { name: "Search files and commands" })
    .click();
  const input = epoch.page.getByRole("combobox", {
    name: "Search files and commands",
  });
  await input.fill("hide sidebar");
  await input.press("Enter");
  await expect(
    epoch.page.getByRole("navigation", { name: "Sidebar" }),
  ).toHaveCount(0);
  await epoch.page.keyboard.press("ControlOrMeta+B");
  await expect(
    epoch.page.getByRole("navigation", { name: "Sidebar" }),
  ).toBeVisible();
});

test("the barrel-imports toggle redraws the graph", async () => {
  // A graph without barrels draws the same either way; this one has one.
  await answerDialogWith(
    path.join(fixtures, "typescript", "conformance", "barrel-named"),
  );
  await epoch.page.getByRole("button", { name: "Open Project…" }).click();
  await laidOut(epoch.page);
  const before = Number(
    await epoch.page.getByTestId("graph-canvas").getAttribute("data-layouts"),
  );
  await epoch.page.getByLabel("Barrel imports").check();
  await laidOut(epoch.page, before + 1);
});

test("clicking a node on the canvas selects it", async () => {
  // One file: after fitting, it sits at the center of the canvas.
  await answerDialogWith(project({ "index.ts": "export const x = 1;\n" }));
  await epoch.page.getByRole("button", { name: "Open Project…" }).click();
  await expect(epoch.page.getByTestId("graph-stats")).toHaveText(
    "1 file · 0 edges",
  );
  await laidOut(epoch.page);
  await epoch.page.getByTestId("graph-canvas").click();
  await expect(detailsTitle(epoch.page)).toHaveText("index.ts");
});

test("a large project starts with folders collapsed and opens them on demand", async () => {
  const files: Record<string, string> = {};
  for (let i = 0; i < 301; i++) {
    files[`src/m${String(i)}.ts`] =
      `export const v${String(i)} = ${String(i)};\n`;
  }
  await answerDialogWith(project(files));
  await epoch.page.getByRole("button", { name: "Open Project…" }).click();
  await expect(epoch.page.getByTestId("graph-stats")).toHaveText(
    "301 files · 0 edges",
  );
  const nodes = epoch.page.locator("button[data-node-id]");
  await expect(nodes).toHaveCount(1);
  await selectNode(epoch.page, "dir:src");
  await expect(details(epoch.page)).toContainText("Files301");
  await epoch.page.getByRole("button", { name: "Open folder" }).click();
  await expect(nodes).toHaveCount(302);
});

test("expanding every folder of a large project packs it, folders drawn as frames", async () => {
  const files: Record<string, string> = {};
  for (let d = 0; d < 30; d++) {
    for (let i = 0; i < 30; i++) {
      const name = `src/f${String(d)}/m${String(i)}.ts`;
      files[name] =
        i === 0
          ? "export const v = 0;\n"
          : 'import { v } from "./m0";\nexport const w = v;\n';
    }
  }
  await answerDialogWith(project(files));
  await epoch.page.getByRole("button", { name: "Open Project…" }).click();
  const canvas = epoch.page.getByTestId("graph-canvas");
  await expect(epoch.page.getByTestId("graph-stats")).toHaveText(
    "900 files · 870 edges",
  );
  await expect(canvas).toHaveAttribute("data-large", "false");
  await epoch.page.getByRole("button", { name: "Expand all folders" }).click();
  // 900 files, 30 folders and src, packed in the worker: well within the
  // time a force layout of every file needed.
  await expect(canvas).toHaveAttribute("data-drawn", "931", {
    timeout: 15_000,
  });
  await expect(canvas).toHaveAttribute("data-large", "true");
  await expect(epoch.page.locator("button[data-node-id]")).toHaveCount(931);
  await selectNode(epoch.page, "src/f3/m0.ts");
  await expect(details(epoch.page)).toContainText("src/f3/m0.ts");
  await epoch.page
    .getByRole("button", { name: "Collapse all folders" })
    .click();
  await expect(canvas).toHaveAttribute("data-large", "false");
});

test("Back to the starting view restores the folders a project opened with", async () => {
  const files: Record<string, string> = {};
  for (let d = 0; d < 6; d++) {
    for (let i = 0; i < 60; i++) {
      files[`src/f${String(d)}/m${String(i)}.ts`] = "export const v = 0;\n";
    }
  }
  await answerDialogWith(project(files));
  await epoch.page.getByRole("button", { name: "Open Project…" }).click();
  const canvas = epoch.page.getByTestId("graph-canvas");
  await expect(epoch.page.getByTestId("graph-stats")).toHaveText(
    "360 files · 0 edges",
  );
  // src open, its six folders closed (each is over the starting budget).
  await expect(canvas).toHaveAttribute("data-drawn", "7");
  const reset = epoch.page.getByRole("button", {
    name: "Back to the starting view",
  });
  await epoch.page.getByRole("button", { name: "Expand all folders" }).click();
  await expect(canvas).toHaveAttribute("data-drawn", "367");
  await expect(canvas).toHaveAttribute("data-large", "true");
  await reset.click();
  await expect(canvas).toHaveAttribute("data-drawn", "7");
  await expect(canvas).toHaveAttribute("data-large", "false");
  await epoch.page
    .getByRole("button", { name: "Collapse all folders" })
    .click();
  await expect(canvas).toHaveAttribute("data-drawn", "1");
  await reset.click();
  await expect(canvas).toHaveAttribute("data-drawn", "7");
});

test("showing a folder that is already open leaves the layout alone", async () => {
  await answerDialogWith(
    project({
      "src/a/one.ts":
        'import { two } from "../b/two";\nexport const one = two;\n',
      "src/b/two.ts": "export const two = 2;\n",
    }),
  );
  await epoch.page.getByRole("button", { name: "Open Project…" }).click();
  await laidOut(epoch.page);
  const canvas = epoch.page.getByTestId("graph-canvas");
  const before = await canvas.getAttribute("data-layouts");
  await epoch.page.locator('[data-tree-id="dir:src/a"]').click();
  await expect(detailsTitle(epoch.page)).toContainText("src/a");
  // Laying out again would move every node; give a stray layout time to land.
  await epoch.page.waitForTimeout(500);
  await expect(canvas).toHaveAttribute("data-layouts", before ?? "");
});

test("File > Open Project… opens a project in the window", async () => {
  await answerDialogWith(
    path.join(fixtures, "typescript", "conformance", "relative"),
  );
  await epoch.app.evaluate(({ Menu }) => {
    const file = Menu.getApplicationMenu()?.items.find(
      (i) => i.label === "File",
    );
    file?.submenu?.items.find((i) => i.label === "Open Project…")?.click();
  });
  await expect(epoch.page.getByTestId("graph-stats")).toHaveText(
    "2 files · 1 edges",
  );
});

test("the focus view puts a file between its dependents and its imports", async () => {
  await answerDialogWith(
    project({
      "src/app.ts": 'import "./b";\nimport "./c";\n',
      "src/b.ts": "export const b = 1;\n",
      "src/c.ts": "export const c = 1;\n",
      "src/main.ts": 'import "./app";\n',
    }),
  );
  await epoch.page.getByRole("button", { name: "Open Project…" }).click();
  await expect(epoch.page.getByTestId("graph-stats")).toHaveText(
    "4 files · 3 edges",
  );
  await selectNode(epoch.page, "src/app.ts");
  await details(epoch.page).getByRole("button", { name: "Focus" }).click();
  await expect(epoch.page.getByTestId("focus-canvas")).toBeVisible();
  const focusNodes = epoch.page.getByRole("list", { name: "Focus nodes" });
  await expect(focusNodes.getByRole("button")).toHaveText([
    "src/app.ts (center)",
    "src/b.ts (imports)",
    "src/c.ts (imports)",
    "src/main.ts (dependents)",
  ]);

  // The inspector lists the same neighbors.
  await epoch.page.getByRole("tab", { name: "Neighbors" }).click();
  const neighbors = epoch.page.getByTestId("neighbors");
  await expect(
    neighbors
      .getByRole("region", { name: "Imports" })
      .getByRole("button", { name: /^src\// }),
  ).toHaveText([/src\/b\.ts/, /src\/c\.ts/]);
  await expect(
    neighbors
      .getByRole("region", { name: "Imported by" })
      .getByRole("button", { name: /^src\// }),
  ).toHaveText([/src\/main\.ts/]);

  // Focusing on a neighbor re-centers on it; Back returns.
  await neighbors.getByRole("button", { name: "Focus on src/main.ts" }).click();
  await expect(focusNodes.getByRole("button")).toHaveText([
    "src/app.ts (imports)",
    "src/main.ts (center)",
  ]);
  await epoch.page.getByRole("button", { name: "Back" }).click();
  await expect(focusNodes.getByRole("button").first()).toHaveText(
    "src/app.ts (center)",
  );

  // Two hops reach the imports of the imports.
  await neighbors.getByRole("button", { name: "Focus on src/main.ts" }).click();
  await neighbors
    .getByRole("group", { name: "Hops" })
    .getByRole("button", { name: "2" })
    .click();
  await expect(focusNodes.getByRole("button")).toHaveText([
    "src/app.ts (imports)",
    "src/b.ts (imports)",
    "src/c.ts (imports)",
    "src/main.ts (center)",
  ]);
  await epoch.page.getByRole("tab", { name: "Details" }).click();
  await epoch.page.keyboard.press("ControlOrMeta+1");
  await expect(epoch.page.getByTestId("graph-canvas")).toBeVisible();
});

test("View menu commands reach the window", async () => {
  const sidebar = epoch.page.getByRole("navigation", { name: "Sidebar" });
  await expect(sidebar).toBeVisible();
  const clickViewItem = (label: string) =>
    epoch.app.evaluate(({ Menu }, l) => {
      const view = Menu.getApplicationMenu()?.items.find(
        (i) => i.label === "View",
      );
      view?.submenu?.items.find((i) => i.label === l)?.click();
    }, label);
  await clickViewItem("Toggle Sidebar");
  await expect(sidebar).toHaveCount(0);
  await clickViewItem("Toggle Sidebar");
  await expect(sidebar).toBeVisible();
  await clickViewItem("Command Palette…");
  await expect(
    epoch.page.getByRole("dialog", { name: "Command palette" }),
  ).toBeVisible();
  await epoch.page.keyboard.press("Escape");
});

test("the title bar leaves room for the native window buttons", async () => {
  // Windows and Linux: the buttons are a Window Controls Overlay. macOS: the
  // traffic lights sit inside the title bar (hiddenInset), not an overlay.
  const overlay = await epoch.page.evaluate(
    () =>
      (navigator as { windowControlsOverlay?: { visible: boolean } })
        .windowControlsOverlay?.visible ?? false,
  );
  expect(overlay).toBe(process.platform !== "darwin");
});

test("the whole flow caused no CSP violations", () => {
  expect(violations).toEqual([]);
});

test("the window and the dismissed privacy note survive a restart", async () => {
  const first = await launch();
  const home = first.home;
  try {
    await first.page.getByRole("button", { name: "Got it" }).click();
    // Well inside the work area, so no OS adjusts it (macOS keeps windows
    // clear of the menu bar); and compare with what the window actually got.
    const before = await first.app.evaluate(({ BrowserWindow, screen }) => {
      const area = screen.getPrimaryDisplay().workArea;
      const win = BrowserWindow.getAllWindows()[0];
      win?.setBounds({
        x: area.x + 40,
        y: area.y + 40,
        width: 900,
        height: Math.min(600, area.height - 80),
      });
      return win?.getBounds();
    });
    expect(before).toBeDefined();
    expect(before).not.toMatchObject({ width: 1280, height: 800 }); // not the default
    await first.quit();
    const second = await launch({}, { home });
    try {
      const after = await second.app.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows()[0]?.getBounds(),
      );
      expect(after).toMatchObject({
        width: before?.width,
        height: before?.height,
      });
      await expect(
        second.page.getByRole("complementary", { name: "Privacy" }),
      ).toHaveCount(0);
    } finally {
      await second.quit();
    }
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});
