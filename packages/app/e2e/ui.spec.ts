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

test("search finds a file and shows it", async () => {
  await epoch.page.getByRole("searchbox", { name: "Find a file" }).fill("A.TS");
  const results = epoch.page.getByRole("list", { name: "Search results" });
  await results.getByRole("button", { name: "src/a.ts" }).click();
  await expect(detailsTitle(epoch.page)).toHaveText("src/a.ts");
});

test("the barrel-imports toggle redraws the graph", async () => {
  const before = Number(
    await epoch.page.getByTestId("graph-canvas").getAttribute("data-layouts"),
  );
  await epoch.page.getByLabel("Barrel imports").check();
  await laidOut(epoch.page, before + 1);
});

test("clicking a node on the canvas selects it", async () => {
  // One file: after fitting, it sits at the center of the canvas.
  await answerDialogWith(project({ "index.ts": "export const x = 1;\n" }));
  await epoch.page.getByRole("button", { name: "Open…" }).click();
  await expect(epoch.page.getByTestId("graph-stats")).toHaveText(
    "1 files · 0 edges",
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
  await epoch.page.getByRole("button", { name: "Open…" }).click();
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
    await first.app.close();
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
      await second.app.close();
    }
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});
