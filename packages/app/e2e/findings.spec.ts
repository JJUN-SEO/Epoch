import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { collectCspViolations, launch, type Launched } from "./launch";

// PLAN.md M5 acceptance: findings as soft alerts. The banner shows only for
// open findings at the banner's level, Review opens the Findings view, a
// dismissal survives a restart, the code preview stays inside the project,
// and the new channels refuse bad payloads.
test.describe.configure({ mode: "serial" });

const fixtures = path.resolve(import.meta.dirname, "../../../fixtures");
const temps: string[] = [];

function tempDir(): string {
  const dir = fs.realpathSync.native(
    fs.mkdtempSync(path.join(os.tmpdir(), "epoch-e2e-findings-")),
  );
  temps.push(dir);
  return dir;
}

function copyFixture(rel: string): string {
  const dir = tempDir();
  fs.cpSync(path.join(fixtures, rel), dir, { recursive: true });
  return dir;
}

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
let violations: string[];
/** This run's user data, cache and dismissals; kept across the restart below. */
const home = fs.mkdtempSync(path.join(os.tmpdir(), "epoch-e2e-findings-home-"));

test.beforeAll(async () => {
  epoch = await launch({}, { home });
  violations = collectCspViolations(epoch.page);
});

test.afterAll(async () => {
  await epoch.close();
  for (const dir of [...temps, home]) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

/** Opens a folder the way a user does: File > Open Project…, then the dialog. */
async function open(e: Launched, folder: string): Promise<void> {
  await e.app.evaluate(({ dialog, Menu }, f) => {
    dialog.showOpenDialog = () =>
      Promise.resolve({ canceled: false, filePaths: [f] });
    const file = Menu.getApplicationMenu()?.items.find(
      (i) => i.label === "File",
    );
    file?.submenu?.items.find((i) => i.label === "Open Project…")?.click();
  }, folder);
  await expect(e.page.getByTestId("graph-stats")).toBeVisible({
    timeout: 30_000,
  });
}

const banner = (page: Page) => page.getByTestId("findings-banner");

test("the banner leads to the Findings view; a dismissal hides it and survives a restart", async () => {
  const dir = copyFixture("typescript/findings/dead-branch-literal");
  const before = snapshot(dir);
  await open(epoch, dir);
  const { page } = epoch;

  await expect(banner(page)).toContainText("1 candidate to review");
  await expect(banner(page)).toContainText("1 branch that likely never runs");
  await banner(page).getByRole("button", { name: "Review" }).click();
  await expect(page.getByTestId("findings-view")).toBeVisible();
  await expect(banner(page)).toHaveCount(0);

  await page.locator("button[data-finding-id]").first().click();
  const details = page.getByTestId("finding-details");
  await expect(details).toContainText("Worth a look");
  await expect(details).toContainText("Branch that likely never runs");
  // Caveats come before the evidence.
  const text = await details.innerText();
  const caveats = text.search(/keep in mind/i);
  expect(caveats).toBeGreaterThanOrEqual(0);
  expect(caveats).toBeLessThan(text.search(/why it was flagged/i));
  await expect(details.getByTestId("code-preview")).toContainText(
    "if (false) {",
  );

  await details.getByRole("textbox").fill("kept for the demo");
  await details.getByRole("button", { name: "Dismiss" }).click();
  await expect(details.getByRole("button", { name: "Restore" })).toBeVisible();
  expect(await page.evaluate(() => window.epoch.getFindings())).toEqual([]);
  expect(
    await page.evaluate(() =>
      window.epoch.getFindings({ includeDismissed: true }),
    ),
  ).toHaveLength(1);
  await page
    .getByRole("button", { name: "Graph", exact: true })
    .first()
    .click();
  await expect(banner(page)).toHaveCount(0);
  expect(snapshot(dir)).toEqual(before); // nothing written into the project

  await epoch.close();
  epoch = await launch({}, { home });
  violations = collectCspViolations(epoch.page);
  await open(epoch, dir);
  expect(await epoch.page.evaluate(() => window.epoch.getFindings())).toEqual(
    [],
  );
  await expect(banner(epoch.page)).toHaveCount(0);
  expect(violations).toEqual([]);
});

test("the code preview reads only inside the project", async () => {
  const outside = tempDir();
  fs.writeFileSync(
    path.join(outside, "secret.ts"),
    "export const SECRET_OUTSIDE_TOKEN = 1;\n",
  );
  const project = tempDir();
  fs.mkdirSync(path.join(project, "src"));
  fs.writeFileSync(
    path.join(project, "src", "index.ts"),
    "export function run(): number {\n  if (false) {\n    return 1;\n  }\n  return 0;\n}\n",
  );
  const linked = process.platform !== "win32";
  if (linked) {
    fs.symlinkSync(
      path.join(outside, "secret.ts"),
      path.join(project, "src", "leak.ts"),
    );
  }
  await open(epoch, project);
  const results = await epoch.page.evaluate(async (withLink) => {
    const bridge = window.epoch as unknown as {
      getCodePreview(...args: unknown[]): Promise<unknown>;
    };
    const attempt = (...args: unknown[]) =>
      bridge.getCodePreview(...args).then(
        (r) => JSON.stringify(r),
        (e: unknown) => String(e),
      );
    return {
      inside: await attempt("src/index.ts", 2, 3),
      link: withLink ? await attempt("src/leak.ts", 1, 1) : "skipped",
      parent: await attempt("../secret.ts", 1, 1),
      absolute: await attempt("/etc/passwd", 1, 1),
      backslash: await attempt("src\\index.ts", 1, 1),
      reversed: await attempt("src/index.ts", 5, 1),
      tooLong: await attempt("src/index.ts", 1, 500),
      notNumber: await attempt("src/index.ts", "1", 2),
    };
  }, linked);
  expect(JSON.parse(results.inside)).toEqual({
    file: "src/index.ts",
    startLine: 2,
    lines: ["  if (false) {", "    return 1;"],
  });
  if (linked) {
    expect(results.link).toContain("cannot be read");
    expect(results.link).not.toContain("SECRET_OUTSIDE_TOKEN");
  }
  for (const r of [
    results.parent,
    results.absolute,
    results.backslash,
    results.reversed,
    results.tooLong,
    results.notNumber,
  ]) {
    expect(r).toContain("invalid payload");
  }
});

test("the findings channels refuse bad payloads", async () => {
  const errors = await epoch.page.evaluate(async () => {
    const bridge = window.epoch as unknown as {
      getFindings(...args: unknown[]): Promise<unknown>;
      dismissFinding(...args: unknown[]): Promise<unknown>;
      undismissFinding(...args: unknown[]): Promise<unknown>;
    };
    const attempts = [
      bridge.getFindings({ kinds: ["everything"] }),
      bridge.getFindings({ minConfidence: "certain" }),
      bridge.getFindings({ extra: true }),
      bridge.dismissFinding("../../etc/passwd"),
      bridge.dismissFinding("a".repeat(200)),
      bridge.dismissFinding("abc", "x".repeat(1001)),
      bridge.dismissFinding(42),
      bridge.undismissFinding(""),
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
});
