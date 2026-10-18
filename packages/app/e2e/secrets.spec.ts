import { randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, test } from "@playwright/test";
import { launch, type Launched } from "./launch";

// The user's key never leaks (CLAUDE.md "Bring your own keys"; ADR-016).
// It is entered in Settings, refused once by the provider, then used for a
// summary. Afterwards no file under the run's user-data, data or cache
// directories, nothing the app printed, nothing in the window or its
// storage, and no bridge answer or rejection holds the key; Epoch's key file
// holds only ciphertext.
test.describe.configure({ mode: "serial" });
test.skip(
  process.platform === "darwin",
  "the macOS keychain may ask for access on a CI runner",
);

const fixtures = path.resolve(import.meta.dirname, "../../../fixtures");
const KEY = `sk-ant-e2e-${randomBytes(12).toString("hex")}`;
const PROSE =
  "Defines a small value that other files import. It has no side effects.";

let epoch: Launched;
let folder: string;
let output = "";

test.beforeAll(async () => {
  folder = fs.realpathSync.native(
    fs.mkdtempSync(path.join(os.tmpdir(), "epoch-e2e-secrets-")),
  );
  fs.cpSync(path.join(fixtures, "typescript/conformance/relative"), folder, {
    recursive: true,
  });
  epoch = await launch();
  const keep = (chunk: Buffer) => {
    output += chunk.toString("utf8");
  };
  epoch.app.process().stdout?.on("data", keep);
  epoch.app.process().stderr?.on("data", keep);
  // Anthropic on main's egress partition: the first request is refused as
  // a bad key (an error path that could echo it), later ones answer. Each
  // records the key it carried, to show the key really was used.
  await epoch.app.evaluate(({ session }, prose) => {
    const keys: (string | null)[] = [];
    (globalThis as { sentKeys?: typeof keys }).sentKeys = keys;
    session
      .fromPartition("epoch-egress", { cache: false })
      .protocol.handle("https", (req) => {
        keys.push(req.headers.get("x-api-key"));
        const body =
          keys.length === 1
            ? {
                type: "error",
                error: {
                  type: "authentication_error",
                  message: "invalid x-api-key",
                },
              }
            : {
                id: "msg_e2e",
                type: "message",
                role: "assistant",
                model: "claude-haiku-5-5",
                content: [{ type: "text", text: prose }],
                stop_reason: "end_turn",
                stop_sequence: null,
                usage: { input_tokens: 120, output_tokens: 20 },
              };
        return new Response(JSON.stringify(body), {
          status: keys.length === 1 ? 401 : 200,
          headers: { "content-type": "application/json" },
        });
      });
  }, PROSE);
  // Allow every limit, store the key (weakly, on Linux without a keyring),
  // and send.
  await epoch.app.evaluate(({ dialog }) => {
    dialog.showMessageBox = () =>
      Promise.resolve({ response: 1, checkboxChecked: false });
  });
});

test.afterAll(async () => {
  await epoch.close();
  fs.rmSync(folder, { recursive: true, force: true });
});

async function select(id: string): Promise<void> {
  // The palette's button, not Ctrl+K: these tests are not about the
  // shortcut (ui.spec covers it), and a synthesized shortcut was twice lost
  // on Linux CI right after a project opened (runs 73 and 78).
  await epoch.page
    .getByRole("button", { name: "Search files and commands" })
    .click();
  const palette = epoch.page.getByRole("dialog", { name: "Command palette" });
  await palette
    .getByRole("combobox", { name: "Search files and commands" })
    .fill(id);
  await palette.getByRole("option", { name: id }).click();
}

const summary = () => epoch.page.getByTestId("summary");

/** Every regular file under `dir`. */
function filesUnder(dir: string): string[] {
  return fs
    .readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((d) => d.isFile())
    .map((d) => path.join(d.parentPath, d.name));
}

/** The forms the key could take in a file: as text, UTF-16, or base64. */
const KEY_FORMS = [
  Buffer.from(KEY, "utf8"),
  Buffer.from(KEY, "utf16le"),
  Buffer.from(Buffer.from(KEY).toString("base64").slice(0, 24), "utf8"),
];

test("the key is entered in Settings, refused once, then used", async () => {
  await epoch.page.evaluate(() =>
    window.epoch.updateSettings({
      summaries: { enabled: true, provider: "anthropic" },
      prices: {
        "anthropic:claude-haiku-5-5": { inputPerMTok: 1, outputPerMTok: 5 },
      },
      spend: { monthlyCapUsd: 1, confirmAboveUsd: 0.5 },
    }),
  );
  await epoch.page.getByRole("button", { name: "Settings" }).click();
  const settings = epoch.page.getByRole("dialog", { name: "Settings" });
  const anthropicKey = settings.getByRole("group", { name: "Anthropic key" });
  const field = anthropicKey.getByLabel("Anthropic API key", { exact: true });
  await field.fill(KEY);
  await anthropicKey.getByRole("button", { name: "Save" }).click();
  await expect(field).toHaveValue("");
  await expect(anthropicKey).toContainText(
    /Set, encrypted by your system|Set, weakly protected/,
  );
  await epoch.page.keyboard.press("Escape");

  await epoch.app.evaluate(({ dialog }, f) => {
    dialog.showOpenDialog = () =>
      Promise.resolve({ canceled: false, filePaths: [f] });
  }, folder);
  await epoch.page.getByRole("button", { name: "Open Project…" }).click();
  await expect(epoch.page.getByTestId("graph-stats")).toHaveText(
    "2 files · 1 edges",
  );
  await select("src/a.ts");
  await summary()
    .getByTestId("summary-approval")
    .getByRole("button", { name: "Summarize" })
    .click();
  await expect(summary()).toContainText("The provider refused the key.");
  // Consent is given now and the estimate is under the ask-first amount.
  await select("src/b.ts");
  await expect(summary().getByTestId("summary-text")).toHaveText(PROSE);
  const sent = await epoch.app.evaluate(
    () => (globalThis as { sentKeys?: (string | null)[] }).sentKeys ?? [],
  );
  expect(sent).toEqual([KEY, KEY]);
});

test("no bridge answer or rejection, and nothing in the window, holds the key", async () => {
  const seen = await epoch.page.evaluate(async (k) => {
    const settle = (p: Promise<unknown>) =>
      p.then(
        (v) => JSON.stringify(v),
        (e: unknown) => (e instanceof Error ? e.message : String(e)),
      );
    const answers = await Promise.all([
      settle(window.epoch.getKeyStatus("anthropic")),
      settle(window.epoch.getSettings()),
      settle(window.epoch.getSpend()),
      settle(window.epoch.getSummary("src/a.ts")),
      settle(window.epoch.getSummary("src/b.ts")),
      settle(window.epoch.getSummary("dir:src")),
      settle(window.epoch.setKey("anthropic", `${k}\n`)),
      settle(window.epoch.setKey("unknown-provider", k)),
    ]);
    const entries = (s: Storage) =>
      Array.from({ length: s.length }, (_, i) => {
        const key = s.key(i) ?? "";
        return [key, s.getItem(key)];
      });
    const storage = JSON.stringify([
      entries(localStorage),
      entries(sessionStorage),
    ]);
    return { answers, storage, dom: document.documentElement.outerHTML };
  }, KEY);
  for (const answer of seen.answers) expect(answer).not.toContain(KEY);
  expect(seen.storage).not.toContain(KEY);
  expect(seen.dom).not.toContain(KEY);
  expect(await epoch.page.content()).not.toContain(KEY);
});

test("after quitting, no file Epoch or Chromium wrote holds the key, and the key file is ciphertext", async () => {
  await epoch.quit();
  // A planted copy shows the scan finds the key where it is.
  const canary = path.join(epoch.home, "canary.txt");
  fs.writeFileSync(canary, `before ${KEY} after`, "utf16le");
  const files = filesUnder(epoch.home);
  expect(files.length).toBeGreaterThan(10);
  const holding = files.filter((file) => {
    const bytes = fs.readFileSync(file);
    return KEY_FORMS.some((form) => bytes.includes(form));
  });
  expect(holding).toEqual([canary]);

  const keyFile = files.filter((f) => path.basename(f) === "keys.json");
  expect(keyFile).toHaveLength(1);
  const stored = JSON.parse(fs.readFileSync(keyFile[0] ?? "", "utf8")) as {
    keys: Record<string, { ciphertext: string }>;
  };
  expect(Object.keys(stored.keys)).toEqual(["anthropic"]);
  const ciphertext = Buffer.from(
    stored.keys.anthropic?.ciphertext ?? "",
    "base64",
  );
  expect(ciphertext.length).toBeGreaterThan(KEY.length);
  expect(ciphertext.includes(Buffer.from(KEY))).toBe(false);

  expect(output).not.toContain(KEY);
});
