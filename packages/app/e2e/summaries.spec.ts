import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, test, type ElectronApplication } from "@playwright/test";
import { launch, type Launched } from "./launch";

// Summaries end to end (M7, ADR-016). The providers are stubbed from the
// test side on main's egress session, which the app's own request filter
// still guards: the app contains no test-only code.
test.describe.configure({ mode: "serial" });

const fixtures = path.resolve(import.meta.dirname, "../../../fixtures");
const KEY = "sk-e2e-SUMMARY-41d9a0";
const PROSE =
  "Defines a small value that other files import. It has no side effects.";

let epoch: Launched;
let folder: string;

test.beforeAll(async () => {
  folder = fs.realpathSync.native(
    fs.mkdtempSync(path.join(os.tmpdir(), "epoch-e2e-summaries-")),
  );
  fs.cpSync(path.join(fixtures, "typescript/conformance/relative"), folder, {
    recursive: true,
  });
  epoch = await launch();
});

test.afterAll(async () => {
  await epoch.close();
  fs.rmSync(folder, { recursive: true, force: true });
});

/**
 * Anthropic's API and Ollama, answered on the egress partition. Each request
 * is recorded in main (destination, key, model), never its prompt.
 */
async function stubProviders(app: ElectronApplication): Promise<void> {
  await app.evaluate(({ session }, prose) => {
    const calls: { origin: string; key: string | null; model: string }[] = [];
    (globalThis as { calls?: typeof calls }).calls = calls;
    const egress = session.fromPartition("epoch-egress", { cache: false });
    const json = (body: unknown) =>
      new Response(JSON.stringify(body), {
        headers: { "content-type": "application/json" },
      });
    egress.protocol.handle("https", async (req) => {
      const body = JSON.parse(await req.text()) as { model: string };
      calls.push({
        origin: new URL(req.url).origin,
        key: req.headers.get("x-api-key"),
        model: body.model,
      });
      return json({
        id: "msg_e2e",
        type: "message",
        role: "assistant",
        model: body.model,
        content: [{ type: "text", text: prose }],
        stop_reason: "end_turn",
        stop_sequence: null,
        usage: { input_tokens: 120, output_tokens: 20 },
      });
    });
    egress.protocol.handle("http", async (req) => {
      const body = JSON.parse(await req.text()) as { model: string };
      calls.push({
        origin: new URL(req.url).origin,
        key: null,
        model: body.model,
      });
      return json({
        message: { role: "assistant", content: prose },
        done_reason: "stop",
        prompt_eval_count: 120,
        eval_count: 20,
      });
    });
  }, PROSE);
}

const calls = (app: ElectronApplication) =>
  app.evaluate(
    () =>
      (
        globalThis as {
          calls?: { origin: string; key: string | null; model: string }[];
        }
      ).calls ?? [],
  );

/** Main's message boxes answer `response` (1: Allow, Send) and record what they asked. */
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

async function openProject(): Promise<void> {
  await epoch.app.evaluate(({ dialog }, f) => {
    dialog.showOpenDialog = () =>
      Promise.resolve({ canceled: false, filePaths: [f] });
  }, folder);
  await epoch.page.getByRole("button", { name: "Open Project…" }).click();
  await expect(epoch.page.getByTestId("graph-stats")).toHaveText(
    "2 files · 1 edges",
  );
}

async function select(id: string): Promise<void> {
  await epoch.page.keyboard.press("ControlOrMeta+K");
  const palette = epoch.page.getByRole("dialog", { name: "Command palette" });
  await palette
    .getByRole("combobox", { name: "Search files and commands" })
    .fill(id);
  await palette.getByRole("option", { name: id }).click();
}

const summary = () => epoch.page.getByTestId("summary");

test("a model on this machine summarizes a file on open, once", async () => {
  await stubProviders(epoch.app);
  await epoch.page.evaluate(() =>
    window.epoch.updateSettings({
      summaries: { enabled: true, provider: "local", localModel: "e2e-model" },
    }),
  );
  await openProject();
  await select("src/a.ts");
  await expect(summary().getByTestId("summary-text")).toHaveText(PROSE);
  await expect(summary()).toContainText("Model-generated · e2e-model");
  expect(await calls(epoch.app)).toEqual([
    { origin: "http://127.0.0.1:11434", key: null, model: "e2e-model" },
  ]);
  // Away and back: the unchanged file's summary comes from the cache.
  await select("src/b.ts");
  await expect(summary().getByTestId("summary-text")).toHaveText(PROSE);
  await select("src/a.ts");
  await expect(summary().getByTestId("summary-text")).toHaveText(PROSE);
  expect(await calls(epoch.app)).toHaveLength(2);
});

test("after a restart the unchanged file's summary is still there, unsent", async () => {
  const home = epoch.home;
  await epoch.quit();
  epoch = await launch({}, { home });
  await stubProviders(epoch.app);
  await openProject();
  await select("src/a.ts");
  await expect(summary().getByTestId("summary-text")).toHaveText(PROSE);
  expect(await calls(epoch.app)).toEqual([]);
});

test("a folder is a confirmed job, summarized bottom-up from its files", async () => {
  const before = (await calls(epoch.app)).length;
  const result = await epoch.page.evaluate(async () => {
    const plan = await window.epoch.getSummary("dir:src", { auto: true });
    if (plan.state !== "needs-approval") return { plan, done: null };
    const done = await window.epoch.generateSummary(plan.planId);
    return { plan, done };
  });
  expect(result.plan).toMatchObject({
    state: "needs-approval",
    reason: "folder-job",
    // src/a.ts was summarized before src/b.ts had a summary, so it is
    // softly stale; the job brings it up to date, then the folder.
    plan: { requests: 2, remote: false },
  });
  expect(result.done).toMatchObject({ state: "ready", text: PROSE });
  expect((await calls(epoch.app)).length - before).toBe(2);
});

test("Anthropic is asked only after consent, with the user's key, and the spend shows", async () => {
  test.skip(
    process.platform === "darwin",
    "the macOS keychain may ask for access on a CI runner",
  );
  await answerMessageBoxes(1); // Allow the limits, store the key, send
  await epoch.page.evaluate(async (key) => {
    await window.epoch.updateSettings({
      summaries: { provider: "anthropic" },
      prices: {
        "anthropic:claude-haiku-5-5": { inputPerMTok: 1, outputPerMTok: 5 },
      },
      spend: { monthlyCapUsd: 1, confirmAboveUsd: 0.5 },
    });
    await window.epoch.setKey("anthropic", key);
  }, KEY);
  const before = (await calls(epoch.app)).length;
  await select("src/b.ts");
  const approval = summary().getByTestId("summary-approval");
  await expect(approval).toContainText("asks before sending anything");
  await expect(approval).toContainText(
    "Sends 1 file to https://api.anthropic.com (claude-haiku-5-5) with your key.",
  );
  expect((await calls(epoch.app)).length).toBe(before);
  await approval.getByRole("button", { name: "Update summary" }).click();
  await expect(summary().getByTestId("summary-text")).toHaveText(PROSE);
  await expect(summary()).toContainText("claude-haiku-5-5");
  const sent = (await calls(epoch.app)).slice(before);
  expect(sent).toEqual([
    {
      origin: "https://api.anthropic.com",
      key: KEY,
      model: "claude-haiku-5-5",
    },
  ]);
  const asked = await epoch.app.evaluate(
    () => (globalThis as { asked?: string[] }).asked ?? [],
  );
  expect(asked.join("\n")).toContain("src/b.ts");
  await expect(epoch.page.getByTestId("spend-status")).toContainText(
    "this month",
  );
  expect(await epoch.page.content()).not.toContain(KEY);
});
