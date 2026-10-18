import fs from "node:fs";
import path from "node:path";
import { expect, test } from "@playwright/test";
import { GRAMMARS } from "@epoch-dev/engine";
import { packagedExecutable, packagedResources, target } from "./launch";
import { E2E_FUSES, readFuses } from "./packaging";

// What the packaged app carries (electron-builder.yml): only this platform's
// native builds, only the grammars the adapters load, TypeScript without its
// compiler and server, and English locales. The rest of the packaged run
// (project.spec.ts and the others) shows the app still works without the
// rest: it analyzes TypeScript, Python and Go projects.
test.skip(target !== "packaged", "inspects the electron-builder --dir output");

const resources = () => packagedResources();

test("the fuses of the e2e build: the installers' plus the inspector", async () => {
  expect(await readFuses(packagedExecutable())).toEqual(E2E_FUSES);
});

/** The paths of the files in app.asar, read from the archive's JSON header. */
function asarPaths(file: string): string[] {
  const fd = fs.openSync(file, "r");
  let header: unknown;
  try {
    const prefix = Buffer.alloc(16);
    fs.readSync(fd, prefix, 0, 16, 0);
    const json = Buffer.alloc(prefix.readUInt32LE(12));
    fs.readSync(fd, json, 0, json.length, 16);
    header = JSON.parse(json.toString("utf8"));
  } finally {
    fs.closeSync(fd);
  }
  interface Node {
    files?: Record<string, Node>;
  }
  const out: string[] = [];
  const walk = (node: Node, prefix: string) => {
    for (const [name, child] of Object.entries(node.files ?? {})) {
      const p = prefix === "" ? name : `${prefix}/${name}`;
      if (child.files) walk(child, p);
      else out.push(p);
    }
  };
  walk(header as Node, "");
  return out;
}

const inAsar = () => asarPaths(path.join(resources(), "app.asar"));

test("only this platform's better-sqlite3 build", () => {
  const prebuilds = path.join(
    resources(),
    "app.asar.unpacked/node_modules/better-sqlite3/prebuilds",
  );
  expect(fs.readdirSync(prebuilds)).toEqual([
    `${process.platform}-${process.arch}.node`,
  ]);
});

// The package's own runtime, wasm/tree-sitter.{js,wasm}, stays (see
// electron-builder.yml); the grammars are the tree-sitter-*.wasm files.
test("only the grammars the adapters load", () => {
  const wasm = "node_modules/@vscode/tree-sitter-wasm/wasm/";
  const shipped = inAsar()
    .filter((p) => p.startsWith(`${wasm}tree-sitter-`) && p.endsWith(".wasm"))
    .map((p) => p.slice(wasm.length))
    .sort();
  expect(shipped).toEqual(
    Object.keys(GRAMMARS)
      .map((name) => `tree-sitter-${name}.wasm`)
      .sort(),
  );
});

test("TypeScript's resolver without its compiler, server or translations", () => {
  const ts = inAsar()
    .filter((p) => p.startsWith("node_modules/typescript/"))
    .map((p) => p.slice("node_modules/typescript/".length));
  expect(ts).toContain("lib/typescript.js");
  expect(ts.filter((p) => /^lib\/[^/]+\.js$/.test(p))).toEqual([
    "lib/typescript.js",
  ]);
  expect(ts.filter((p) => /^(lib\/[^/]+\/|bin\/)/.test(p))).toEqual([]);
});

test("no source maps and no debug builds", () => {
  expect(
    inAsar().filter(
      (p) =>
        p.endsWith(".map") ||
        p.startsWith("node_modules/web-tree-sitter/debug/"),
    ),
  ).toEqual([]);
});

test("English locales only", () => {
  if (process.platform === "darwin") {
    const lproj = fs
      .readdirSync(resources())
      .filter((f) => f.endsWith(".lproj"))
      .sort();
    expect(lproj.length).toBeGreaterThan(0);
    expect(lproj.every((f) => /^en([_-][A-Z]{2})?\.lproj$/.test(f))).toBe(true);
  } else {
    const locales = path.join(path.dirname(packagedExecutable()), "locales");
    expect(fs.readdirSync(locales).sort()).toEqual(["en-GB.pak", "en-US.pak"]);
  }
});

test("the app icon", () => {
  test.skip(process.platform !== "darwin", "a macOS bundle carries icon.icns");
  expect(fs.statSync(path.join(resources(), "icon.icns")).size).toBeGreaterThan(
    10_000,
  );
});
