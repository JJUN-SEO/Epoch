import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, test } from "@playwright/test";
import { collectCspViolations, launch, type Launched } from "./launch";

// ADR-020: a report written after the project opened shows at once; the
// coverage panel names the commands, and a report chosen in main's dialog
// replaces looking, is remembered for the project, and can be cleared.
test.describe.configure({ mode: "serial" });

const temps: string[] = [];

function folder(prefix: string): string {
  const dir = fs.realpathSync.native(
    fs.mkdtempSync(path.join(os.tmpdir(), prefix)),
  );
  temps.push(dir);
  return dir;
}

function write(dir: string, rel: string, content: string): void {
  fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
  fs.writeFileSync(path.join(dir, rel), content);
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

/** The next native open dialog answers `file` (main's dialog, stubbed). */
async function dialogAnswers(file: string): Promise<void> {
  await epoch.app.evaluate(({ dialog }, f) => {
    dialog.showOpenDialog = () =>
      Promise.resolve({ canceled: false, filePaths: [f] });
  }, file);
}

/** Opens a folder the way a user does: File > Open Project…, then the dialog. */
async function open(dir: string): Promise<void> {
  await dialogAnswers(dir);
  await epoch.app.evaluate(({ Menu }) => {
    const file = Menu.getApplicationMenu()?.items.find(
      (i) => i.label === "File",
    );
    file?.submenu?.items.find((i) => i.label === "Open Project…")?.click();
  });
}

test("coverage reports: found live, chosen in the panel, remembered and cleared", async () => {
  const dir = folder("epoch-e2e-coverage-");
  write(dir, "src/a.ts", 'import { b } from "./b";\nexport const a = b;\n');
  write(dir, "src/b.ts", "export const b = 1;\n");
  write(dir, "build/reports/unit.lcov", "SF:src/a.ts\nDA:1,1\nend_of_record\n");
  const outside = folder("epoch-e2e-coverage-outside-");
  write(outside, "lcov.info", "SF:src/a.ts\nDA:1,1\nend_of_record\n");
  const { page } = epoch;
  const status = page.getByTestId("coverage-status");

  await open(dir);
  // The first analysis of a fresh launch starts the parse workers.
  await expect(page.getByTestId("graph-stats")).toHaveText(
    "2 files · 1 edges",
    { timeout: 20_000 },
  );
  await expect(status).toHaveText("No test coverage report");

  // A test run writes its report (and an HTML report beside it).
  write(dir, "coverage/lcov-report/index.html", "<html></html>");
  write(dir, "coverage/lcov.info", "SF:src/b.ts\nDA:1,1\nend_of_record\n");
  await expect(status).toHaveText("Test coverage: coverage/lcov.info", {
    timeout: 20_000,
  });

  await status.click();
  const panel = page.getByRole("dialog", { name: "Test coverage" });
  await expect(panel.getByTestId("coverage-reports")).toHaveText(
    "coverage/lcov.info (lcov): 1 file",
  );
  await expect(panel).toContainText("npx vitest run --coverage");
  await expect(panel).toContainText("go test -coverprofile=cover.out ./...");

  // A file outside the project is refused, and nothing changes.
  await dialogAnswers(path.join(outside, "lcov.info"));
  await panel.getByRole("button", { name: "Choose report…" }).click();
  await expect(panel.getByRole("status")).toHaveText(
    "Choose a report inside the project folder.",
  );
  await expect(status).toHaveText("Test coverage: coverage/lcov.info");

  // One inside, even in a folder Epoch does not analyze, replaces looking.
  await dialogAnswers(path.join(dir, "build", "reports", "unit.lcov"));
  await panel.getByRole("button", { name: "Choose report…" }).click();
  await expect(status).toHaveText("Test coverage: build/reports/unit.lcov");
  await expect(panel).toContainText("Chosen by you");

  // Remembered for the project when it is opened again.
  await page.keyboard.press("Escape");
  await open(dir);
  await expect(status).toHaveText("Test coverage: build/reports/unit.lcov", {
    timeout: 20_000,
  });

  await status.click();
  await panel.getByRole("button", { name: "Look for reports again" }).click();
  await expect(status).toHaveText("Test coverage: coverage/lcov.info");
  await expect(panel).not.toContainText("Chosen by you");
  expect(violations).toEqual([]);
});
