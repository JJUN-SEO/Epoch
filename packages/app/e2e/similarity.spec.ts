import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, test } from "@playwright/test";
import type { Graph } from "@epoch-dev/core";
import {
  collectCspViolations,
  launch,
  packagedResources,
  target,
  type Launched,
} from "./launch";

// M6 (ADR-008): similarity hints from the local embedding model, computed in
// the analysis host on this machine after the first graph is shown. The
// packaged app runs the model its installer carries; the build runs the
// repository's fetched model, or the engine's tiny test model without one.

const REPO = path.resolve(import.meta.dirname, "../../..");

function modelEnv(): Record<string, string> | undefined {
  if (target === "packaged") {
    // Only "off" reaches a packaged app; it uses its bundled model.
    return fs.existsSync(path.join(packagedResources(), "model/model.onnx"))
      ? { EPOCH_EMBEDDING_MODEL: "" }
      : undefined;
  }
  const manifest = JSON.parse(
    fs.readFileSync(path.join(REPO, "models/manifest.json"), "utf8"),
  ) as { default: string };
  const fetched = path.join(REPO, "models", manifest.default);
  return {
    EPOCH_EMBEDDING_MODEL: fs.existsSync(path.join(fetched, "model.onnx"))
      ? fetched
      : path.join(REPO, "packages/engine/src/fixtures/tiny-embedder"),
  };
}

const env = modelEnv();
let epoch: Launched | undefined;
const temps: string[] = [];

test.afterAll(async () => {
  await epoch?.close();
  for (const dir of temps) fs.rmSync(dir, { recursive: true, force: true });
});

test("similarity hints come from the local model, after the first graph", async () => {
  test.skip(
    env === undefined,
    "This packaged build carries no model (scripts/fetch-model.mjs was not run before packaging).",
  );
  const dir = fs.realpathSync.native(
    fs.mkdtempSync(path.join(os.tmpdir(), "epoch-e2e-similar-")),
  );
  temps.push(dir);
  const files = {
    "src/auth/login.ts":
      "export async function login(user: string, password: string) {\n  return createSession(user, password);\n}\n",
    "src/auth/logout.ts":
      "export async function logout(user: string) {\n  return destroySession(user);\n}\n",
    "src/ui/button.tsx":
      "export function Button(props: { label: string }) {\n  return props.label;\n}\n",
  };
  for (const [rel, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), text);
  }
  epoch = await launch(env);
  const { app, page } = epoch;
  const violations = collectCspViolations(page);
  await app.evaluate(({ dialog, Menu }, f) => {
    dialog.showOpenDialog = () =>
      Promise.resolve({ canceled: false, filePaths: [f] });
    const file = Menu.getApplicationMenu()?.items.find(
      (i) => i.label === "File",
    );
    file?.submenu?.items.find((i) => i.label === "Open Project…")?.click();
  }, dir);

  await expect(page.getByTestId("graph-stats")).toHaveText("3 files · 0 edges");
  const status = page.getByTestId("hints-status");
  // Pending ("adding similarity…") until the second pass is done.
  await expect(status).toHaveText(/^\d+ likely relations?$/, {
    timeout: 60_000,
  });
  await expect(status).toHaveAttribute(
    "title",
    /similar content \(\d+ pairs?, .+@[0-9a-f]{12}, on this machine\)/,
  );
  const graph: Graph = await page.evaluate(() => window.epoch.getGraph());
  expect(graph.nodes).toHaveLength(3);
  expect(violations).toEqual([]);
});
