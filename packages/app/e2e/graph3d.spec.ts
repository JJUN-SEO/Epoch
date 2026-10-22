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
  await expect(epoch.page.getByTestId("graph-stats")).toContainText(" edges");
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

    // The pointer now rests on src/app.ts. Choosing another file moves the
    // camera, and the highlight follows the new selection, not the stale
    // hover (its label is the bold one).
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    const bold = page.getByTestId("graph3d-labels").locator(".font-semibold");
    await expect(bold).toHaveText("app.ts");
    const other = page.locator('button[data-node3d-id="lib/d.ts"]');
    await other.focus();
    await other.press("Enter");
    await expect(detailsTitle(page)).toHaveText("lib/d.ts");
    await expect(bold).toHaveText("d.ts");
    await page.waitForTimeout(1200);
    await page.mouse.click(box.x + 12, box.y + 12);
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    await expect(detailsTitle(page)).toHaveText("lib/d.ts");
    await listed.focus();
    await listed.press("Enter");
    await page.waitForTimeout(1200);

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

test("when the GPU drops the 3D view's context, it says so and restarts", async () => {
  const epoch = await launch({}, undefined, SOFTWARE_WEBGL);
  try {
    await open(
      epoch,
      project({
        "src/app.ts": 'import "./b";\n',
        "src/b.ts": "export const b = 1;\n",
      }),
    );
    const page = epoch.page;
    await dimensions(page).getByRole("button", { name: "3D" }).click();
    const canvas = page.getByTestId("graph3d-canvas");
    const layouts = async () =>
      Number(await canvas.getAttribute("data-layouts"));
    await expect.poll(layouts).toBeGreaterThanOrEqual(1);
    const before = await layouts();

    // What a GPU driver reset does to the page: the canvas's WebGL context
    // is lost, and nothing draws on it again by itself.
    await page.evaluate(() => {
      const c = document.querySelector<HTMLCanvasElement>(
        '[data-testid="graph3d-canvas"] canvas',
      );
      c?.getContext("webgl2")
        ?.getExtension("WEBGL_lose_context")
        ?.loseContext();
    });
    const trouble = page.getByTestId("graph3d-trouble");
    await expect(trouble).toContainText(
      "The graphics driver stopped the 3D view",
    );

    // Restarting builds a new scene, which shows the finished layout at once.
    await trouble.getByRole("button", { name: "Restart 3D view" }).click();
    await expect(trouble).toHaveCount(0);
    await expect(canvas.locator("canvas")).toHaveCount(1);
    await expect.poll(layouts).toBeGreaterThan(before);
    const listed = page.locator('button[data-node3d-id="src/app.ts"]');
    await listed.focus();
    await listed.press("Enter");
    await expect(detailsTitle(page)).toHaveText("src/app.ts");
  } finally {
    await epoch.close();
  }
});

test("without WebGL the 3D option is off, with the reason", async () => {
  // Software WebGL is on, so only the page-level override below removes it:
  // the page then sees what a computer without WebGL shows it.
  const epoch = await launch({}, undefined, SOFTWARE_WEBGL);
  try {
    await epoch.page.addInitScript(() => {
      const proto = HTMLCanvasElement.prototype;
      const original = Object.getOwnPropertyDescriptor(proto, "getContext")
        ?.value as (this: HTMLCanvasElement, ...args: unknown[]) => unknown;
      Object.defineProperty(proto, "getContext", {
        value(this: HTMLCanvasElement, type: string, ...rest: unknown[]) {
          if (type.startsWith("webgl")) return null;
          return original.call(this, type, ...rest);
        },
      });
    });
    await epoch.page.reload();
    await epoch.page.waitForLoadState("load");
    await open(epoch, project({ "a.ts": "export const a = 1;\n" }));
    const option = dimensions(epoch.page).getByRole("button", { name: "3D" });
    await expect(option).toBeDisabled();
    await expect(option).toHaveAttribute("title", /needs WebGL/);
  } finally {
    await epoch.close();
  }
});
