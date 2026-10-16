import childProcess from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { serializeCanonical, type Graph } from "@epoch-dev/core";
import { analyze } from "@epoch-dev/engine";
import { collectCspViolations, launch, type Launched } from "./launch";

// PLAN.md M4 acceptance: editing a file updates the graph; a branch switch
// ends equal to a full recompute. Plus blast radius and risk in the UI.
test.describe.configure({ mode: "serial" });

const temps: string[] = [];

function project(files: Readonly<Record<string, string>>): string {
  const dir = fs.realpathSync.native(
    fs.mkdtempSync(path.join(os.tmpdir(), "epoch-e2e-live-")),
  );
  temps.push(dir);
  for (const [rel, content] of Object.entries(files)) write(dir, rel, content);
  return dir;
}

function write(dir: string, rel: string, content: string): void {
  fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
  fs.writeFileSync(path.join(dir, rel), content);
}

const git = (cwd: string, ...args: string[]) =>
  childProcess.execFileSync(
    "git",
    [
      "-c",
      "user.email=t@example.com",
      "-c",
      "user.name=t",
      "-c",
      "commit.gpgsign=false",
      ...args,
    ],
    { cwd, stdio: "pipe" },
  );

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

/** Opens a folder the way a user does: File > Open Project…, then the dialog. */
async function open(folder: string): Promise<void> {
  await epoch.app.evaluate(({ dialog, Menu }, f) => {
    dialog.showOpenDialog = () =>
      Promise.resolve({ canceled: false, filePaths: [f] });
    const file = Menu.getApplicationMenu()?.items.find(
      (i) => i.label === "File",
    );
    file?.submenu?.items.find((i) => i.label === "Open Project…")?.click();
  }, folder);
}

const stats = (page: Page) => page.getByTestId("graph-stats");
const mainGraph = (page: Page): Promise<Graph> =>
  page.evaluate(() => window.epoch.getGraph());

async function selectNode(page: Page, id: string): Promise<void> {
  const button = page.locator(`button[data-node-id="${id}"]`);
  await button.focus();
  await button.press("Enter");
}

const FILES = {
  "src/a.ts": 'import { b } from "./b";\nexport const a = b;\n',
  "src/b.ts": "export const b = 1;\n",
};

test("the graph follows edits, deletions and a branch switch", async () => {
  const dir = project(FILES);
  git(dir, "init", "-q", "-b", "main");
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "one");
  git(dir, "checkout", "-q", "-b", "feature");
  write(dir, "src/b.ts", 'import { d } from "./d";\nexport const b = d;\n');
  write(dir, "src/d.ts", "export const d = 2;\n");
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "two");
  git(dir, "checkout", "-q", "main");

  await open(dir);
  const { page } = epoch;
  await expect(stats(page)).toHaveText("2 files · 1 edges");
  await expect(page.getByTestId("watch-status")).toHaveText("Watching");
  await expect(page.getByTestId("git-status")).toContainText("Churn: 90 days");
  await expect(page.getByTestId("coverage-status")).toHaveText(
    "No coverage report",
  );

  write(dir, "src/c.ts", 'import { a } from "./a";\nexport const c = a;\n');
  await expect(stats(page)).toHaveText("3 files · 2 edges", {
    timeout: 20_000,
  });
  await expect(page.getByTestId("watch-status")).toContainText("Updated");

  fs.rmSync(path.join(dir, "src/b.ts"));
  await expect(stats(page)).toHaveText(
    "2 files · 1 edges · 1 unresolved imports",
    { timeout: 20_000 },
  );

  git(dir, "checkout", "-q", "--", "src/b.ts");
  git(dir, "checkout", "-q", "feature");
  await expect(stats(page)).toHaveText("4 files · 3 edges", {
    timeout: 20_000,
  });
  // Main's graph (deltas applied) equals a fresh analysis of the folder.
  const fresh = serializeCanonical((await analyze(dir)).graph);
  await expect
    .poll(async () => serializeCanonical(await mainGraph(page)), {
      timeout: 20_000,
    })
    .toBe(fresh);
  expect(violations).toEqual([]);
});

test("blast radius colors what depends on the selected file, by depth", async () => {
  const dir = project({
    "src/c.ts": "export const c = 1;\n",
    "src/b.ts": 'import { c } from "./c";\nexport const b = c;\n',
    "src/a.ts": 'import { b } from "./b";\nexport const a = b;\n',
    "src/other.ts": "export const other = 1;\n",
  });
  await open(dir);
  const { page } = epoch;
  await expect(stats(page)).toHaveText("4 files · 2 edges");
  await selectNode(page, "src/c.ts");
  await page.getByRole("button", { name: "Blast radius" }).click();

  const impact = page.getByTestId("impact");
  await expect(impact).toBeVisible();
  await expect(page.getByTestId("impact-total")).toHaveText("2 files");
  await expect(impact).toContainText("Direct dependents (1)");
  await expect(impact).toContainText("2 levels away (1)");
  await expect(page.getByTestId("impact-legend")).toBeVisible();
  await expect(impact.getByRole("button", { name: "Likely" })).toBeDisabled();

  await impact.getByLabel("Depth").selectOption("1");
  await expect(page.getByTestId("impact-total")).toHaveText("1 file");

  // The palette command turns it off again.
  await page.keyboard.press(
    process.platform === "darwin" ? "Meta+K" : "Control+K",
  );
  await page.keyboard.type("Hide Blast Radius");
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("impact-legend")).toBeHidden();
  expect(violations).toEqual([]);
});

test("hint edges stay hidden until asked; the slider filters them, and Likely blast radius follows them", async () => {
  const dir = project({
    "src/a.ts": 'import { b } from "./b";\nexport const a = b;\n',
    "src/b.ts": "export const b = 1;\n",
    "src/c.ts": "export const c = 1;\n",
  });
  git(dir, "init", "-q", "-b", "main");
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "one");
  // b and c change together in every commit that touches either.
  for (let i = 0; i < 3; i++) {
    fs.appendFileSync(path.join(dir, "src/b.ts"), "// edit\n");
    fs.appendFileSync(path.join(dir, "src/c.ts"), "// edit\n");
    git(dir, "add", "-A");
    git(dir, "commit", "-q", "-m", `edit ${String(i)}`);
  }
  await open(dir);
  const { page } = epoch;
  await expect(stats(page)).toHaveText("3 files · 1 edges");
  await expect(page.getByTestId("hints-status")).toHaveText(
    "2 likely relations",
  );
  const hints = (await mainGraph(page)).edges.filter((e) => e.confidence < 1);
  const atLeast = (t: number) =>
    String(hints.filter((e) => e.confidence >= t).length);
  const canvas = page.getByTestId("graph-canvas");
  // Facts only by default (CLAUDE.md "Edge traversal policy").
  await expect(canvas).toHaveAttribute("data-hint-edges", "0");

  await page.getByLabel("Hints", { exact: true }).check();
  await expect(canvas).toHaveAttribute("data-hint-edges", atLeast(0.5));
  const slider = page.getByLabel("Lowest hint confidence");
  await slider.press("End");
  await expect(canvas).toHaveAttribute("data-hint-edges", atLeast(0.95));
  await slider.press("Home");
  await expect(canvas).toHaveAttribute("data-hint-edges", atLeast(0.2));

  // The details list them apart from imports, with their evidence as text.
  await selectNode(page, "src/c.ts");
  await page.getByRole("tab", { name: "Details" }).click();
  const likely = page.getByTestId("likely-related");
  await expect(likely).toContainText("src/b.ts");
  await expect(likely).toContainText(
    "changed in 4 of the 4 commits that changed src/b.ts",
  );

  // Likely mode adds what changes with b: c, at the slider's threshold.
  await selectNode(page, "src/b.ts");
  await page.getByRole("tab", { name: "Impact" }).click();
  const impact = page.getByTestId("impact");
  await expect(page.getByTestId("impact-total")).toHaveText("1 file");
  await impact.getByRole("button", { name: "Likely", exact: true }).click();
  await expect(page.getByTestId("impact-total")).toHaveText("2 files");
  await expect(page.getByTestId("impact-via-hints")).toContainText(
    "1 reached only through likely relations",
  );
  await expect(impact).toContainText("likely");

  await page.getByLabel("Hints", { exact: true }).uncheck();
  await expect(canvas).toHaveAttribute("data-hint-edges", "0");
  expect(violations).toEqual([]);
});

test("risk needs git history, and says so without it", async () => {
  const dir = project(FILES);
  await open(dir);
  const { page } = epoch;
  await expect(stats(page)).toHaveText("2 files · 1 edges");
  await expect(page.getByTestId("git-status")).toHaveText("No git history");
  await selectNode(page, "src/b.ts");
  await page.getByRole("tab", { name: "Details" }).click();
  await expect(page.getByTestId("risk")).toContainText(
    "Risk needs git history; this folder isn't a git repository",
  );

  git(dir, "init", "-q", "-b", "main");
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "one");
  await open(dir);
  await expect(page.getByTestId("git-status")).toContainText("Churn: 90 days");
  await selectNode(page, "src/b.ts");
  await expect(page.getByTestId("risk-score")).toHaveText(/^\d+\.\d$/);
  await expect(page.getByTestId("risk")).toContainText("Imported by");
  expect(violations).toEqual([]);
});
