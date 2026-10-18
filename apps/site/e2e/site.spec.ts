import { expect, test } from "@playwright/test";

const demos = [
  { id: "zod", name: "zod", stats: "526 files" },
  { id: "flask", name: "Flask", stats: "83 files" },
  { id: "cli", name: "GitHub CLI", stats: "423 packages · 510 files" },
] as const;

test("landing links to every offline demo and installer", async ({ page }) => {
  await page.goto("./");
  await expect(
    page.getByRole("heading", { name: /See the shape of/i }),
  ).toBeVisible();
  for (const { id } of demos)
    await expect(
      page.locator(`a[href="./demo.html?repo=${id}"]`).first(),
    ).toBeVisible();
  await expect(page.locator('a[href$="Epoch-mac-arm64.dmg"]')).toBeVisible();
  await expect(
    page.locator('a[href$="Epoch-win-x64-setup.exe"]'),
  ).toBeVisible();
  await expect(page.locator('a[href$="Epoch-linux-x64.deb"]')).toBeVisible();
  await expect(
    page.locator('a[href$="Epoch-linux-x64.AppImage"]'),
  ).toBeVisible();
});

for (const demo of demos) {
  test(`${demo.name} demo loads only its own site resources`, async ({
    page,
  }) => {
    const outside: string[] = [];
    const violations: string[] = [];
    page.on("request", (request) => {
      if (new URL(request.url()).origin !== "http://127.0.0.1:4173")
        outside.push(request.url());
    });
    page.on("console", (message) => {
      if (message.type() === "error") violations.push(message.text());
    });
    page.on("pageerror", (error) => violations.push(error.message));
    await page.goto(`./demo.html?repo=${demo.id}`);
    await expect(page.getByTestId("attribution")).toContainText(demo.name);
    await expect(page.getByTestId("attribution")).toContainText(
      "No source code or model features",
    );
    await expect(page.getByTestId("graph-stats")).toContainText(demo.stats);
    expect(await page.evaluate(() => "epoch" in window)).toBe(false);
    expect(outside).toEqual([]);
    expect(violations).toEqual([]);
  });
}

test("zod shows reviewable findings in the static app", async ({ page }) => {
  await page.goto("./demo.html?repo=zod");
  await expect(page.getByTestId("findings-banner")).toBeVisible();
  await page
    .getByTestId("findings-banner")
    .getByRole("button", { name: "Review" })
    .click();
  await expect(
    page.getByText("Candidates for review, not verdicts"),
  ).toBeVisible();
});
