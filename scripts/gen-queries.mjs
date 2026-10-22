// Embeds the tree-sitter queries in queries/<language>/*.scm into each
// adapter's source as string constants (packages/adapters/<language>/src/
// queries.generated.ts).
//
// Why: an adapter that reads its query from a path relative to its own file
// breaks as soon as its code moves, whether bundled into the desktop app or
// installed from npm. The .scm files stay the source of truth (CLAUDE.md repo
// layout); `--check` fails when a generated file is out of date, and `pnpm lint`
// runs it.
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const check = process.argv.includes("--check");

/** imports.scm -> IMPORTS_QUERY; call-sites.scm -> CALL_SITES_QUERY. */
const constantName = (file) =>
  `${path
    .basename(file, ".scm")
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "_")}_QUERY`;

function render(language, files) {
  const lines = [
    `// Generated from queries/${language}/ by scripts/gen-queries.mjs. Do not edit;`,
    "// edit the .scm file and run `node scripts/gen-queries.mjs`.",
  ];
  for (const file of files) {
    const text = readFileSync(
      path.join(root, "queries", language, file),
      "utf8",
    ).replace(/\r\n/g, "\n");
    lines.push("", `/** queries/${language}/${file} */`);
    lines.push(`export const ${constantName(file)} = ${JSON.stringify(text)};`);
  }
  return `${lines.join("\n")}\n`;
}

let stale = 0;
const languages = readdirSync(path.join(root, "queries"), {
  withFileTypes: true,
})
  .filter((d) => d.isDirectory())
  .map((d) => d.name)
  .sort();
for (const language of languages) {
  const files = readdirSync(path.join(root, "queries", language))
    .filter((f) => f.endsWith(".scm"))
    .sort();
  const adapterSrc = path.join(root, "packages", "adapters", language, "src");
  if (!existsSync(adapterSrc)) {
    throw new Error(
      `queries/${language} has no adapter at packages/adapters/${language}`,
    );
  }
  const target = path.join(adapterSrc, "queries.generated.ts");
  const expected = render(language, files);
  const actual = existsSync(target) ? readFileSync(target, "utf8") : "";
  if (actual === expected) continue;
  if (check) {
    stale++;
    process.stderr.write(
      `${path.relative(root, target)} is out of date; run node scripts/gen-queries.mjs\n`,
    );
  } else {
    writeFileSync(target, expected);
    process.stdout.write(`wrote ${path.relative(root, target)}\n`);
  }
}
if (stale > 0) process.exitCode = 1;
