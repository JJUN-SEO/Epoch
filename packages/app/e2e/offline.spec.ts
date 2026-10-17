import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { expect, test } from "@playwright/test";
import { launch, type Launched } from "./launch";

// Offline mode (CLAUDE.md "Privacy and data flow", ADR-016): with it on, a
// full analysis and a summary attempt make no network request at all, in
// any process. Chromium's network log records the requests every session
// makes through the network stack; a canary first shows it sees a model
// request. The local model is therefore a real server on 127.0.0.1 (a
// protocol handler would answer before the network stack). Anthropic is
// stubbed on main's egress partition and counted, as a second witness. The
// host's and main's tripwires would print any Node-level attempt.
test.describe.configure({ mode: "serial" });

const fixtures = path.resolve(import.meta.dirname, "../../../fixtures");
const OLLAMA = "http://127.0.0.1:11434";
const PROSE =
  "Defines a small value that other files import. It has no side effects.";
const temps: string[] = [];

function copyFixture(rel: string): string {
  const dir = fs.realpathSync.native(
    fs.mkdtempSync(path.join(os.tmpdir(), "epoch-e2e-offline-")),
  );
  temps.push(dir);
  fs.cpSync(path.join(fixtures, rel), dir, { recursive: true });
  return dir;
}

let epoch: Launched;
let small: string;
let output = "";
let ollama: http.Server;
let ollamaCalls = 0;

/** Answers like Ollama's /api/chat (non-streaming). */
function startOllama(): Promise<http.Server> {
  const server = http.createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      ollamaCalls++;
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
  const { hostname, port } = new URL(OLLAMA);
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(Number(port), hostname, () => {
      resolve(server);
    });
  });
}

test.beforeAll(async () => {
  ollama = await startOllama();
  small = copyFixture("typescript/conformance/relative");
  epoch = await launch();
  const keep = (chunk: Buffer) => {
    output += chunk.toString("utf8");
  };
  epoch.app.process().stdout?.on("data", keep);
  epoch.app.process().stderr?.on("data", keep);
  await epoch.app.evaluate(({ session }) => {
    let count = 0;
    (globalThis as { anthropicCalls?: () => number }).anthropicCalls = () =>
      count;
    session
      .fromPartition("epoch-egress", { cache: false })
      .protocol.handle("https", () => {
        count++;
        return new Response("{}", { status: 500 });
      });
  });
});

test.afterAll(async () => {
  await epoch.close();
  await new Promise((resolve) => ollama.close(resolve));
  for (const dir of temps) fs.rmSync(dir, { recursive: true, force: true });
});

const anthropicCalls = () =>
  epoch.app.evaluate(
    () =>
      (globalThis as { anthropicCalls?: () => number }).anthropicCalls?.() ??
      -1,
  );

/** The URLs of every request Chromium's network stack made while `run` ran. */
async function netLogDuring(run: () => Promise<void>): Promise<string[]> {
  const file = path.join(epoch.home, `netlog-${String(Date.now())}.json`);
  await epoch.app.evaluate(({ netLog }, f) => netLog.startLogging(f), file);
  try {
    await run();
  } finally {
    await epoch.app.evaluate(({ netLog }) => netLog.stopLogging());
  }
  const log = JSON.parse(fs.readFileSync(file, "utf8")) as {
    events?: { params?: { url?: unknown } }[];
  };
  const urls = new Set<string>();
  for (const e of log.events ?? [])
    if (typeof e.params?.url === "string") urls.add(e.params.url);
  return [...urls].sort();
}

async function open(folder: string, files: string): Promise<void> {
  await epoch.app.evaluate(({ dialog }, f) => {
    dialog.showOpenDialog = () =>
      Promise.resolve({ canceled: false, filePaths: [f] });
  }, folder);
  // File > Open Project… (its shortcut is a native menu accelerator, which
  // keys typed into the page do not reliably reach).
  await epoch.app.evaluate(({ Menu }) => {
    const file = Menu.getApplicationMenu()?.items.find(
      (i) => i.label === "File",
    );
    file?.submenu?.items.find((i) => i.label === "Open Project…")?.click();
  });
  await expect(epoch.page.getByTestId("graph-stats")).toContainText(files);
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

test("the network log sees a model request (the canary)", async () => {
  await epoch.page.evaluate(() =>
    window.epoch.updateSettings({
      summaries: { enabled: true, provider: "local", localModel: "e2e-model" },
    }),
  );
  await open(small, "2 files");
  const urls = await netLogDuring(async () => {
    await select("src/a.ts");
    await expect(summary().getByTestId("summary-text")).toHaveText(PROSE);
  });
  expect(urls).toContain(`${OLLAMA}/api/chat`);
  expect(ollamaCalls).toBe(1);
});

test("offline: a full analysis and a summary attempt make no request", async () => {
  // Remote summaries configured, so a summary would go to Anthropic.
  await epoch.app.evaluate(({ dialog }) => {
    dialog.showMessageBox = () =>
      Promise.resolve({ response: 1, checkboxChecked: false });
  });
  await epoch.page.evaluate(() =>
    window.epoch.updateSettings({
      offline: true,
      summaries: { provider: "anthropic" },
      prices: {
        "anthropic:claude-haiku-5-5": { inputPerMTok: 1, outputPerMTok: 5 },
      },
      spend: { monthlyCapUsd: 1 },
    }),
  );
  await expect(epoch.page.getByTestId("offline-status")).toBeVisible();
  const before = ollamaCalls;
  const big = copyFixture("typescript/monorepo");
  let attempt: unknown;
  const urls = await netLogDuring(async () => {
    await open(big, "files");
    await open(small, "2 files");
    await select("src/a.ts");
    await expect(summary()).toContainText("Offline mode is on.");
    // The last summary stays readable, marked as made another way.
    await expect(summary().getByTestId("summary-text")).toHaveText(PROSE);
    attempt = await epoch.page.evaluate(() =>
      window.epoch.getSummary("src/b.ts", { auto: true }),
    );
  });
  expect(attempt).toMatchObject({ state: "unavailable", reason: "offline" });
  expect(urls).toEqual([]);
  expect(await anthropicCalls()).toBe(0);
  expect(ollamaCalls).toBe(before);
  expect(output).not.toContain("tried to use the network");
});

test("offline: a model on this machine still works", async () => {
  await epoch.page.evaluate(() =>
    window.epoch.updateSettings({ summaries: { provider: "local" } }),
  );
  const before = ollamaCalls;
  const urls = await netLogDuring(async () => {
    await select("src/b.ts");
    await expect(summary().getByTestId("summary-text")).toHaveText(PROSE);
  });
  expect(urls).toEqual([`${OLLAMA}/api/chat`]);
  expect(ollamaCalls).toBe(before + 1);
  expect(await anthropicCalls()).toBe(0);
  expect(output).not.toContain("tried to use the network");
});
