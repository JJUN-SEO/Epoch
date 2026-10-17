import { expect, test } from "@playwright/test";
import { launch, type Launched } from "./launch";

// Settings (M7, ADR-016): every change goes through main, which confirms
// spending raises in its own dialog; a key is sent once and never shown.
test.describe.configure({ mode: "serial" });

const SENTINEL = "sk-e2e-SETTINGS-8c2b71";

let epoch: Launched;

test.beforeAll(async () => {
  epoch = await launch();
});

test.afterAll(async () => {
  await epoch.close();
});

/** Main's message boxes answer `response` and record what they asked. */
async function answerMessageBoxes(response: number): Promise<void> {
  await epoch.app.evaluate(({ dialog }, r) => {
    const asked: string[] = [];
    (globalThis as { asked?: string[] }).asked = asked;
    dialog.showMessageBox = (...args: unknown[]) => {
      const options = args.at(-1) as { message?: string; detail?: string };
      asked.push(`${options.message ?? ""}\n${options.detail ?? ""}`);
      return Promise.resolve({ response: r, checkboxChecked: false });
    };
  }, response);
}

const asked = () =>
  epoch.app.evaluate(() => (globalThis as { asked?: string[] }).asked ?? []);

const settings = () => epoch.page.getByRole("dialog", { name: "Settings" });

test("Settings opens from the title bar and changes what main keeps", async () => {
  await epoch.page.getByRole("button", { name: "Settings" }).click();
  await expect(settings()).toBeVisible();
  const offline = settings().getByRole("checkbox", {
    name: "Offline mode",
    exact: true,
  });
  await offline.check();
  await expect
    .poll(() => epoch.page.evaluate(() => window.epoch.getSettings()))
    .toMatchObject({ offline: true });
  await expect(
    settings().getByRole("checkbox", { name: "Check for updates" }),
  ).not.toBeChecked();
  await offline.uncheck();
  await settings()
    .getByRole("checkbox", { name: "Summaries", exact: true })
    .check();
  await expect
    .poll(() =>
      epoch.page.evaluate(() =>
        window.epoch.getSettings().then((s) => s.summaries.enabled),
      ),
    )
    .toBe(true);
  await epoch.page.keyboard.press("Escape");
  await expect(settings()).toHaveCount(0);
});

test("Settings opens from the native menu", async () => {
  await epoch.app.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0]?.webContents.send(
      "epoch:menu-command",
      "settings",
    );
  });
  await expect(settings()).toBeVisible();
});

test("raising the monthly cap asks in main's own dialog first", async () => {
  await answerMessageBoxes(0); // Cancel
  await settings().getByLabel("Monthly cap in dollars").fill("2");
  await settings().getByRole("button", { name: "Save limits" }).click();
  await expect(settings().getByRole("alert")).toContainText("not confirmed");
  expect((await asked()).join("\n")).toContain("monthly cap none → $2.00");
  await answerMessageBoxes(1); // Allow
  await settings().getByRole("button", { name: "Save limits" }).click();
  await expect(settings().getByLabel("Spending so far")).toContainText(
    "of $2.00",
  );
});

test("a price is entered by the user, confirmed like any raise", async () => {
  await answerMessageBoxes(1);
  await settings().getByLabel("Input price per million tokens").fill("1");
  await settings().getByLabel("Output price per million tokens").fill("5");
  await settings()
    .getByRole("region", { name: "Prices" })
    .getByRole("button", { name: "Save" })
    .click();
  await expect
    .poll(() =>
      epoch.page.evaluate(() =>
        window.epoch.getSettings().then((s) => Object.keys(s.prices)),
      ),
    )
    .toEqual(["anthropic:claude-haiku-5-5"]);
  expect((await asked()).join("\n")).toContain("price set: $1.00 in");
});

test("a key goes in once: the field clears and only its status shows", async () => {
  test.skip(
    process.platform === "darwin",
    "the macOS keychain may ask for access on a CI runner",
  );
  await answerMessageBoxes(0); // Linux without a keyring: this session only
  const field = settings().getByLabel("Anthropic API key");
  await field.fill(SENTINEL);
  await settings()
    .getByRole("region", { name: "Keys" })
    .getByRole("button", { name: "Save" })
    .click();
  await expect(field).toHaveValue("");
  await expect(settings().getByRole("region", { name: "Keys" })).toContainText(
    /Set until Epoch quits|Set, encrypted by your system|Set, weakly protected/,
  );
  expect(await epoch.page.content()).not.toContain(SENTINEL);
  await settings().getByRole("button", { name: "Remove" }).click();
  await expect(settings().getByRole("region", { name: "Keys" })).toContainText(
    "Not set",
  );
});

test("the cache shows its size, and Clear says how many paid summaries it deletes", async () => {
  await expect(settings().getByLabel("Cache size")).toContainText(
    "on this machine",
  );
  await settings().getByRole("button", { name: "Clear…" }).click();
  await expect(settings()).toContainText("Deletes 0 paid summaries.");
  await settings().getByRole("button", { name: "Clear cache" }).click();
  await expect(settings().getByLabel("Cache size")).toContainText(
    "0 summaries (0 paid)",
  );
});
