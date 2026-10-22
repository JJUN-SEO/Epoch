import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { embeddingModelDir, hostModelArgs } from "./model";

const APP = fileURLToPath(new URL("../..", import.meta.url));
const REPO = path.resolve(APP, "../..");

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0))
    fs.rmSync(d, { recursive: true, force: true });
});

/** A fake layout: <root>/packages/app, <root>/models/<id>, resources/model. */
function layout(opts: {
  manifest?: unknown;
  model?: string;
  bundled?: boolean;
}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "epoch-model-dir-"));
  dirs.push(root);
  const appPath = path.join(root, "packages/app");
  fs.mkdirSync(appPath, { recursive: true });
  const writeSpec = (dir: string) => {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "epoch-model.json"), "{}");
  };
  if (opts.manifest !== undefined) {
    fs.mkdirSync(path.join(root, "models"), { recursive: true });
    fs.writeFileSync(
      path.join(root, "models/manifest.json"),
      JSON.stringify(opts.manifest),
    );
  }
  if (opts.model !== undefined)
    writeSpec(path.join(root, "models", opts.model));
  const resourcesPath = path.join(root, "resources");
  if (opts.bundled === true) writeSpec(path.join(resourcesPath, "model"));
  return { root, appPath, resourcesPath };
}

describe("embeddingModelDir", () => {
  it("uses the bundled model in a packaged app, and ignores the environment", () => {
    const l = layout({ bundled: true });
    const env = { EPOCH_EMBEDDING_MODEL: "/elsewhere" };
    expect(embeddingModelDir({ packaged: true, ...l, env })).toBe(
      path.join(l.resourcesPath, "model"),
    );
    const none = layout({});
    expect(embeddingModelDir({ packaged: true, ...none, env })).toBeUndefined();
  });

  it("uses EPOCH_EMBEDDING_MODEL, else the manifest's default, when unpackaged", () => {
    const l = layout({ manifest: { default: "m1" }, model: "m1" });
    expect(embeddingModelDir({ packaged: false, ...l, env: {} })).toBe(
      path.join(l.root, "models/m1"),
    );
    expect(
      embeddingModelDir({
        packaged: false,
        ...l,
        env: { EPOCH_EMBEDDING_MODEL: "/some/model" },
      }),
    ).toBe(path.resolve("/some/model"));
  });

  it('turns the model off with EPOCH_EMBEDDING_MODEL "off", packaged or not', () => {
    const l = layout({
      manifest: { default: "m1" },
      model: "m1",
      bundled: true,
    });
    const env = { EPOCH_EMBEDDING_MODEL: "off" };
    expect(embeddingModelDir({ packaged: true, ...l, env })).toBeUndefined();
    expect(embeddingModelDir({ packaged: false, ...l, env })).toBeUndefined();
  });

  it("finds nothing when the default model was not fetched or the manifest is odd", () => {
    for (const l of [
      layout({ manifest: { default: "m1" } }),
      layout({ manifest: { default: "../m1" }, model: "m1" }),
      layout({ manifest: [] }),
      layout({}),
    ]) {
      expect(
        embeddingModelDir({ packaged: false, ...l, env: {} }),
      ).toBeUndefined();
    }
  });

  it("passes the folder to the host as one argument pair", () => {
    expect(hostModelArgs(undefined)).toEqual([]);
    expect(hostModelArgs("/m")).toEqual(["--embedding-model", "/m"]);
  });
});

describe("packaging", () => {
  it("bundles the manifest's default model as the app's model", () => {
    const manifest = JSON.parse(
      fs.readFileSync(path.join(REPO, "models/manifest.json"), "utf8"),
    ) as { default: string };
    const config = fs.readFileSync(
      path.join(APP, "electron-builder.yml"),
      "utf8",
    );
    expect(config).toContain(`from: ../../models/${manifest.default}\n`);
    expect(config).toMatch(/\n {4}to: model\n/);
  });
});
