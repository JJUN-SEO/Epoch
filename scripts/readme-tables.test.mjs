import assert from "node:assert/strict";
import { test } from "node:test";
import {
  cellOf,
  composeTable,
  fillTables,
  tableUnder,
} from "./readme-tables.mjs";

const source =
  "## Results\n\n| Name | Value | Note |\n| --- | --- | --- |\n| run | 42 | a |\n| walk | 7 | a |\n";
const map = { sources: { result: { file: "report.md", heading: "Results" } } };

test("copies the selected table and refuses a hand-edited cell", () => {
  assert.equal(
    tableUnder(source, "Results"),
    "| Name | Value | Note |\n| --- | --- | --- |\n| run | 42 | a |\n| walk | 7 | a |",
  );
  const markers =
    "<!-- BEGIN GENERATED:result -->\nold\n<!-- END GENERATED:result -->\n";
  const copied = fillTables(markers, map, () => source);
  assert.match(copied, /\| run \| 42 \| a \|/);
  const edited = copied.replace("42", "43");
  assert.notEqual(
    edited,
    fillTables(edited, map, () => source),
  );
});

test("reads one cell by row and column, and refuses an ambiguous row", () => {
  const table = tableUnder(source, "Results");
  assert.equal(cellOf(table, "walk", "Value"), "7");
  assert.equal(cellOf(table, "Value=42", "Name"), "run");
  assert.throws(() => cellOf(table, "Note=a", "Value"), /matches 2 rows/);
  assert.throws(() => cellOf(table, "swim", "Value"), /matches 0 rows/);
  assert.throws(() => cellOf(table, "run", "Size"), /No column/);
});

test("a composed table takes its numbers from the reports", () => {
  const spec = {
    header: ["Measure", "Result"],
    rows: [["Run and walk", "{result|run|Value} and {result|walk|Value}"]],
  };
  const table = composeTable(spec, () => tableUnder(source, "Results"));
  assert.equal(
    table,
    "| Measure | Result |\n| --- | --- |\n| Run and walk | 42 and 7 |",
  );
  const used = new Set();
  const filled = fillTables(
    "<!-- BEGIN GENERATED:glance -->\n<!-- END GENERATED:glance -->\n",
    { ...map, composed: { glance: spec } },
    () => source,
    used,
  );
  assert.match(filled, /\| Run and walk \| 42 and 7 \|/);
  assert.deepEqual([...used], ["glance"]);
});

test("an unknown generated block fails", () => {
  assert.throws(
    () =>
      fillTables(
        "<!-- BEGIN GENERATED:nope -->\n<!-- END GENERATED:nope -->\n",
        map,
        () => source,
      ),
    /Unknown generated table: nope/,
  );
});
