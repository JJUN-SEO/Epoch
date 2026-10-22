// No measured number in README.md or docs/results.md is typed by hand. Each
// <!-- BEGIN GENERATED:id --> ... <!-- END GENERATED:id --> block in those
// files is filled from scripts/readme-tables.json: a "sources" id copies one
// table whole from the report that produced it; a "composed" id builds a
// summary table whose {source|row|column} cells are read from those tables.
// Usage: node scripts/readme-tables.mjs [--check]
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import prettier from "prettier";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

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

/** The cells of one table row (escaped pipes stay inside their cell). */
function cells(line) {
  return line
    .trim()
    .replace(/^\|/, "")
    .replace(/(?<!\\)\|$/, "")
    .split(/(?<!\\)\|/)
    .map((cell) => cell.trim());
}

/**
 * One cell of a markdown table. `row` names the row by its first cell, or
 * as `Column=value` by another column's cell; it must match exactly one row.
 */
export function cellOf(table, row, column) {
  const [header = [], , ...body] = table.split("\n").map(cells);
  const at = header.indexOf(column);
  assert.ok(at >= 0, `No column ${column} in: ${header.join(", ")}`);
  const eq = row.indexOf("=");
  const by = eq > 0 ? header.indexOf(row.slice(0, eq)) : -1;
  const key = by >= 0 ? row.slice(eq + 1) : row;
  const matches = body.filter((r) => r[by >= 0 ? by : 0] === key);
  assert.equal(matches.length, 1, `Row ${row} matches ${matches.length} rows`);
  return matches[0][at];
}

/** A summary table: the header, then each row with its cells filled in. */
export function composeTable(spec, tableOf) {
  const fill = (text) =>
    text.replace(/\{([^{}|]+)\|([^{}|]+)\|([^{}|]+)\}/g, (_, id, row, column) =>
      cellOf(tableOf(id), row, column),
    );
  const line = (row) => `| ${row.map(fill).join(" | ")} |`;
  return [
    line(spec.header),
    `| ${spec.header.map(() => "---").join(" | ")} |`,
    ...spec.rows.map(line),
  ].join("\n");
}

/**
 * Fills every generated block in `text`. Returns the new text and records
 * the ids it used in `used`.
 */
export function fillTables(text, map, readFile, used = new Set()) {
  const sources = map.sources ?? {};
  const composed = map.composed ?? {};
  const tableOf = (id) => {
    const source = sources[id];
    assert.ok(source, `No source table: ${id}`);
    return tableUnder(readFile(source.file), source.heading, source.table ?? 0);
  };
  let result = text.replaceAll("\r\n", "\n");
  const ids = [...result.matchAll(/<!-- BEGIN GENERATED:([\w-]+) -->/g)].map(
    (m) => m[1],
  );
  for (const id of ids) {
    const begin = `<!-- BEGIN GENERATED:${id} -->`;
    const end = `<!-- END GENERATED:${id} -->`;
    const first = result.indexOf(begin);
    const last = result.indexOf(end);
    assert.ok(last > first, `Markers missing or out of order: ${id}`);
    assert.equal(result.indexOf(begin, first + 1), -1, `Duplicate ${id}`);
    let table;
    if (sources[id]) table = tableOf(id);
    else if (composed[id]) table = composeTable(composed[id], tableOf);
    else assert.fail(`Unknown generated table: ${id}`);
    used.add(id);
    result = `${result.slice(0, first + begin.length)}\n\n${table}\n\n${result.slice(last)}`;
  }
  return result;
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const map = JSON.parse(
    fs.readFileSync(path.join(root, "scripts/readme-tables.json"), "utf8"),
  );
  const check = process.argv.includes("--check");
  const used = new Set();
  for (const target of map.targets) {
    const file = path.join(root, target);
    const current = fs.readFileSync(file, "utf8").replaceAll("\r\n", "\n");
    const filled = fillTables(
      current,
      map,
      (source) => fs.readFileSync(path.join(root, source), "utf8"),
      used,
    );
    const next = await prettier.format(filled, { filepath: file });
    if (check)
      assert.equal(
        current,
        next,
        `${target}: generated tables are stale; run node scripts/readme-tables.mjs`,
      );
    else fs.writeFileSync(file, next);
  }
  const unused = [
    ...Object.keys(map.sources ?? {}),
    ...Object.keys(map.composed ?? {}),
  ].filter((id) => !used.has(id));
  assert.deepEqual(unused, [], "Tables no target uses");
}
