import assert from "node:assert/strict";
import { test } from "node:test";
import { copyTables, tableUnder } from "./readme-tables.mjs";

test("copies the selected table and refuses a hand-edited README cell", () => {
  const source =
    "## Results\n\n| Name | Value |\n| --- | --- |\n| run | 42 |\n";
  assert.equal(
    tableUnder(source, "Results"),
    "| Name | Value |\n| --- | --- |\n| run | 42 |",
  );
  const markers =
    "<!-- BEGIN GENERATED:result -->\nold\n<!-- END GENERATED:result -->\n";
  const map = { result: { file: "report.md", heading: "Results" } };
  const copied = copyTables(markers, map, () => source);
  assert.match(copied, /\| run \| 42 \|/);
  assert.notEqual(
    copied.replace("42", "43"),
    copyTables(copied.replace("42", "43"), map, () => source),
  );
});
