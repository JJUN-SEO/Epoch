// README benchmark and privacy tables are exact copies of the source reports.
// Usage: node scripts/readme-tables.mjs [--check]
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import prettier from "prettier";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const map = JSON.parse(
  fs.readFileSync(path.join(root, "scripts/readme-tables.json"), "utf8"),
);

/** The numbered table in one heading's section, including its header. */
export function tableUnder(markdown, heading, number = 0) {
  const lines = markdown.replaceAll("\r\n", "\n").split("\n");
  const start = lines.findLastIndex(
    (line) => /^#{1,6} /.test(line) && line.replace(/^#{1,6} /, "") === heading,
  );
  assert.ok(start >= 0, `No heading: ${heading}`);
  const tables = [];
  for (let i = start + 1; i < lines.length; i++) {
    if (/^#{1,6} /.test(lines[i])) break;
    if (!lines[i].startsWith("|")) continue;
    const rows = [];
    while (i < lines.length && lines[i].startsWith("|")) rows.push(lines[i++]);
    tables.push(rows.join("\n"));
  }
  assert.ok(tables[number], `No table ${number} under ${heading}`);
  assert.match(tables[number], /^\|[^\n]+\n\|[ -:|]+\n\|/);
  return tables[number];
}

export function copyTables(readme, mapping, readFile) {
  let result = readme.replaceAll("\r\n", "\n");
  for (const [id, source] of Object.entries(mapping)) {
    const sourceText = readFile(source.file);
    const table = tableUnder(sourceText, source.heading, source.table ?? 0);
    const begin = `<!-- BEGIN GENERATED:${id} -->`;
    const end = `<!-- END GENERATED:${id} -->`;
    const first = result.indexOf(begin);
    const last = result.indexOf(end);
    assert.ok(first >= 0 && last > first, `README markers missing: ${id}`);
    assert.equal(
      result.indexOf(begin, first + 1),
      -1,
      `README has duplicate ${id}`,
    );
    result = `${result.slice(0, first + begin.length)}\n\n${table}\n\n${result.slice(last)}`;
  }
  return result;
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const file = path.join(root, "README.md");
  const current = fs.readFileSync(file, "utf8").replaceAll("\r\n", "\n");
  const next = await prettier.format(
    copyTables(current, map, (source) =>
      fs.readFileSync(path.join(root, source), "utf8"),
    ),
    { filepath: file },
  );
  if (process.argv.includes("--check")) {
    assert.equal(
      current,
      next,
      "README tables are stale; run node scripts/readme-tables.mjs",
    );
  } else {
    fs.writeFileSync(file, next);
  }
}
