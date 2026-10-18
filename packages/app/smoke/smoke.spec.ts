import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { INSTALLER_FUSES, readFuses } from "../e2e/packaging";
import { startInstalled } from "./drive";

// The clean-machine smoke test (PLAN.md M8, ADR-018): run by installers.yml
// on a fresh runner per installer, after installing it the way a user would.
// EPOCH_SMOKE_EXE is the installed executable, EPOCH_SMOKE_REPO a real
// repository with its full history (zod at its pinned commit), and
// EPOCH_SMOKE_FUSES the binary whose fuses to read when the executable is a
// wrapper (the AppImage).
test.describe.configure({ mode: "serial" });

const exe = process.env.EPOCH_SMOKE_EXE ?? "";
const repo = process.env.EPOCH_SMOKE_REPO ?? "";
test.skip(
  exe === "" || repo === "",
  "set EPOCH_SMOKE_EXE and EPOCH_SMOKE_REPO",
);

const fixture = path.resolve(
  import.meta.dirname,
  "../../../fixtures/typescript/conformance/relative",
);
const OLLAMA = "http://127.0.0.1:11434";
const PROSE =
  "Defines a small value that other files import. It has no side effects.";

/** A copy of the small fixture outside the checkout. */
function smallProject(): string {
  const dir = fs.realpathSync.native(
    fs.mkdtempSync(path.join(os.tmpdir(), "epoch-smoke-project-")),
  );
  fs.cpSync(fixture, dir, { recursive: true });
  return dir;
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

async function openRecent(page: Page, folder: string, files: RegExp) {
  await page
    .getByRole("button", { name: new RegExp(escape(path.basename(folder))) })
    .first()
    .click();
  await expect(page.getByTestId("graph-stats")).toContainText(files, {
    timeout: 120_000,
  });
}

async function select(page: Page, id: string) {
  await page.getByRole("button", { name: "Search files and commands" }).click();
  const palette = page.getByRole("dialog", { name: "Command palette" });
  await palette
    .getByRole("combobox", { name: "Search files and commands" })
    .fill(id);
  await palette.getByRole("option", { name: id }).click();
}

test("the installed app carries the installers' fuses", async () => {
  expect(await readFuses(process.env.EPOCH_SMOKE_FUSES ?? exe)).toEqual(
    INSTALLER_FUSES,
  );
});

test("a real repository: graph, blast radius, findings, offline mode, and no request", async () => {
  const run = await startInstalled(exe, {
    settings: { updateChecks: false },
    recent: [repo],
  });
  try {
    const { page } = run;
    await openRecent(page, repo, /\d+ files/);

    // The file most others import, and what changing it can affect.
    const central = await page.evaluate(async () => {
      const graph = await window.epoch.getGraph();
      const [top] = [...graph.nodes].sort(
        (a, b) => b.metrics.fanIn - a.metrics.fanIn || a.id.localeCompare(b.id),
      );
      return top?.id ?? "";
    });
    await select(page, central);
    await page.getByRole("button", { name: "Blast radius" }).click();
    await expect(page.getByTestId("impact-total")).toHaveText(
      /^[1-9]\d* files?$/,
    );

    // The findings banner, and its Review button.
    const banner = page.getByTestId("findings-banner");
    await expect(banner).toContainText(/candidates? to review/);
    await banner.getByRole("button", { name: "Review" }).click();
    await expect(page.getByTestId("findings-view")).toBeVisible();
    await page.locator("button[data-finding-id]").first().click();
    await expect(page.getByTestId("finding-details")).toBeVisible();

    // Offline mode, from Settings.
    await page.getByRole("button", { name: "Settings" }).click();
    const settings = page.getByRole("dialog", { name: "Settings" });
    await settings
      .getByRole("checkbox", { name: "Offline mode", exact: true })
      .check();
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("offline-status")).toBeVisible();
  } catch (e) {
    throw new Error(`${String(e)}\nThe app printed:\n${run.output()}`, {
      cause: e,
    });
  } finally {
    await run.quit();
  }
  // No keys and update checks off: not one request (CLAUDE.md "Privacy").
  expect(run.urls()).toEqual([]);
});

test("the network log does see a request when one is made (the canary)", async () => {
  let calls = 0;
  const server = http.createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      calls++;
      res.setHeader("content-type", "application/json");
      res.end(
        JSON.stringify({
          message: { role: "assistant", content: PROSE },
          done_reason: "stop",
          prompt_eval_count: 1,
          eval_count: 1,
        }),
      );
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(11434, "127.0.0.1", resolve);
  });
  const project = smallProject();
  const run = await startInstalled(exe, {
    settings: {
      updateChecks: false,
      summaries: { enabled: true, provider: "local", localModel: "smoke" },
    },
    recent: [project],
  });
  try {
    await openRecent(run.page, project, /2 files/);
    await select(run.page, "src/a.ts");
    await expect(
      run.page.getByTestId("summary").getByTestId("summary-text"),
    ).toHaveText(PROSE);
  } finally {
    await run.quit();
    await new Promise((resolve) => server.close(resolve));
  }
  expect(calls).toBe(1);
  expect(run.urls()).toEqual([`${OLLAMA}/api/chat`]);
});

test("offline mode with update checks on: no request", async () => {
  const project = smallProject();
  const run = await startInstalled(exe, {
    settings: { offline: true, updateChecks: true },
    recent: [project],
  });
  try {
    await openRecent(run.page, project, /2 files/);
    await select(run.page, "src/a.ts");
    await expect(run.page.getByTestId("offline-status")).toBeVisible();
  } finally {
    await run.quit();
  }
  expect(run.urls()).toEqual([]);
});
