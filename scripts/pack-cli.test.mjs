import assert from "node:assert/strict";
import { test } from "node:test";
import {
  LEFT_OUT,
  publishedManifest,
  thirdPartyDependencies,
} from "./pack-cli.mjs";

const manifests = new Map(
  [
    {
      name: "@epoch-dev/cli",
      dependencies: {
        "@epoch-dev/engine": "workspace:*",
        zod: "catalog:",
        "@modelcontextprotocol/server": "2.4.0",
      },
    },
    {
      name: "@epoch-dev/engine",
      dependencies: {
        "@epoch-dev/core": "workspace:*",
        "better-sqlite3": "catalog:",
        "onnxruntime-node": "1.30.0",
        "@huggingface/tokenizers": "0.2.0",
        chokidar: "5.0.0",
      },
    },
    {
      name: "@epoch-dev/core",
      dependencies: { zod: "catalog:", graphology: "0.26.0" },
    },
    { name: "@epoch-dev/unused", dependencies: { leftpad: "1.0.0" } },
  ].map((m) => [m.name, m]),
);
const catalog = { zod: "4.6.7", "better-sqlite3": "13.0.3" };

test("collects third-party dependencies through the workspace, sorted, at pinned versions", () => {
  assert.deepEqual(
    thirdPartyDependencies("@epoch-dev/cli", manifests, catalog),
    {
      "@modelcontextprotocol/server": "2.4.0",
      "better-sqlite3": "13.0.3",
      chokidar: "5.0.0",
      graphology: "0.26.0",
      zod: "4.6.7",
    },
  );
});

test("leaves out the embedding runtime, and nothing else", () => {
  assert.deepEqual([...LEFT_OUT].sort(), [
    "@huggingface/tokenizers",
    "onnxruntime-node",
  ]);
});

test("refuses two versions of one dependency, and a missing catalog entry", () => {
  const twice = new Map(manifests);
  twice.set("@epoch-dev/core", {
    name: "@epoch-dev/core",
    dependencies: { chokidar: "4.0.0" },
  });
  assert.throws(
    () => thirdPartyDependencies("@epoch-dev/cli", twice, catalog),
    /chokidar is pinned twice: 4\.0\.0 and 5\.0\.0/,
  );
  assert.throws(
    () => thirdPartyDependencies("@epoch-dev/cli", manifests, {}),
    /no catalog version for zod/,
  );
});

test("the published manifest names the bin, the files and a release version", () => {
  const m = publishedManifest(
    {
      name: "@epoch-dev/cli",
      license: "MIT",
      optionalDependencies: { "@napi-rs/keyring": "2.1.0" },
    },
    "1.2.3",
    { zod: "4.6.7" },
  );
  assert.equal(m.name, "@epoch-dev/cli");
  assert.equal(m.version, "1.2.3");
  assert.deepEqual(m.bin, { epoch: "dist/bin.js" });
  assert.deepEqual(m.files, ["dist"]);
  assert.deepEqual(m.dependencies, { zod: "4.6.7" });
  assert.deepEqual(m.optionalDependencies, { "@napi-rs/keyring": "2.1.0" });
  assert.deepEqual(m.publishConfig, { access: "public" });
  assert.equal(m.private, undefined);
  assert.throws(
    () => publishedManifest({ name: "x", license: "MIT" }, "0.0.0-dev", {}),
    /not MAJOR\.MINOR\.PATCH/,
  );
});
