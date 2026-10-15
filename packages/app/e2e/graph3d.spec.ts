import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { collectCspViolations, launch, type Launched } from "./launch";

// The optional 3D overview (ADR-012). CI machines have no GPU, and Chromium
// no longer falls back to software WebGL on its own, so this test opts into
// SwiftShader with a launch switch. The app never sets it.
test.describe.configure({ mode: "serial" });

const SOFTWARE_WEBGL = ["--enable-unsafe-swiftshader"];
const temps: string[] = [];

function project(files: Readonly<Record<string, string>>): string {
  const dir = fs.realpathSync.native(
    fs.mkdtempSync(path.join(os.tmpdir(), "epoch-e2e-3d-")),
  );
  temps.push(dir);
  for (const [rel, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), content);
  }
  return dir;
}

async function open(epoch: Launched, folder: string): Promise<void> {
  await epoch.app.evaluate(({ dialog }, f) => {
    dialog.showOpenDialog = () =>
      Promise.resolve({ canceled: false, filePaths: [f] });
  }, folder);
  await epoch.page.getByRole("button", { name: "Open Project…" }).click();
  await expect(epoch.page.getByTestId("graph-stats")).toContainText("files");
}

const dimensions = (page: Page) =>
  page.getByRole("group", { name: "Dimensions" });
const detailsTitle = (page: Page) =>
  page.getByTestId("details").getByRole("heading", { level: 2 });

test.afterAll(() => {
  for (const dir of temps) fs.rmSync(dir, { recursive: true, force: true });
});

test("the 3D overview draws the files, and clicking picks them", async () => {
  const epoch = await launch({}, undefined, SOFTWARE_WEBGL);
  const violations = collectCspViolations(epoch.page);
  try {
    await open(
      epoch,
      project({
        "src/app.ts": 'import "./b";\nimport "./c";\n',
        "src/b.ts": 'import "../lib/d";\n',
        "src/c.ts": "export const c = 1;\n",
        "lib/d.ts": "export const d = 1;\n",
      }),
    );
    const page = epoch.page;
    await dimensions(page).getByRole("button", { name: "3D" }).click();
    const canvas = page.getByTestId("graph3d-canvas");
    await expect
      .poll(async () => Number(await canvas.getAttribute("data-layouts")))
      .toBeGreaterThanOrEqual(1);
    await expect(canvas.locator("canvas")).toHaveCount(1);
    await expect(page.getByTestId("graph-canvas")).toBeHidden();

    // Choosing a file from the accessible list selects it and flies to it.
    const listed = page.locator('button[data-node3d-id="src/app.ts"]');
    await listed.focus();
    await listed.press("Enter");
    await expect(detailsTitle(page)).toHaveText("src/app.ts");

    // The file now sits in the middle of the canvas: clicking empty space
    // clears the selection, and clicking the middle picks the file again.
    await page.waitForTimeout(1200);
    const box = await canvas.boundingBox();
    if (!box) throw new Error("no canvas");
    await page.mouse.click(box.x + 12, box.y + 12);
    await expect(page.getByTestId("details")).toHaveCount(0);
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    await expect(detailsTitle(page)).toHaveText("src/app.ts");

    // Double-clicking it opens the focus view on it.
    await page.mouse.dblclick(box.x + box.width / 2, box.y + box.height / 2);
    await expect(
      page
        .getByRole("list", { name: "Focus nodes" })
        .getByRole("button")
        .first(),
    ).toHaveText("src/app.ts (center)");

    // Back to the graph, still in 3D; then 2D again.
    await page.keyboard.press("ControlOrMeta+1");
    await expect(canvas).toBeVisible();
    await dimensions(page).getByRole("button", { name: "2D" }).click();
    await expect(page.getByTestId("graph-canvas")).toBeVisible();
    await expect(page.getByTestId("graph3d-canvas")).toHaveCount(0);
    expect(violations).toEqual([]);
  } finally {
    await epoch.close();
  }
});

test("without WebGL the 3D option is off, with the reason", async () => {
  const epoch = await launch({}, undefined, ["--disable-webgl"]);
  try {
    await open(epoch, project({ "a.ts": "export const a = 1;\n" }));
    const option = dimensions(epoch.page).getByRole("button", { name: "3D" });
    await expect(option).toBeDisabled();
    await expect(option).toHaveAttribute("title", /needs WebGL/);
  } finally {
    await epoch.close();
  }
});
