/**
 * pnpm bench:findings:score [--csv docs/benchmarks/findings-review.csv]
 *
 * Precision per confidence level from the review sheet's verdicts (filled
 * by a person: yes, no or unsure). Unsure rows and empty verdicts are
 * counted but left out of precision. Prints a markdown table.
 */
import fs from "node:fs";
import { parseArgs } from "node:util";
import { pct, table } from "./report.js";

/** RFC 4180 rows (quoted cells, doubled quotes, newlines inside quotes). */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text.charAt(i);
    if (quoted) {
      if (c === '"' && text.charAt(i + 1) === '"') {
        cell += '"';
        i++;
      } else if (c === '"') quoted = false;
      else cell += c;
    } else if (c === '"') quoted = true;
    else if (c === ",") {
      row.push(cell);
      cell = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && text.charAt(i + 1) === "\n") i++;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
    } else cell += c;
  }
  if (cell !== "" || row.length > 0) {
    row.push(cell);
    rows.push(row);
  }
  return rows;
}

export interface Score {
  readonly level: string;
  readonly yes: number;
  readonly no: number;
  readonly unsure: number;
  readonly blank: number;
}

export function score(rows: readonly string[][]): Score[] {
  const [header, ...body] = rows;
  const col = (name: string) => header?.indexOf(name) ?? -1;
  const level = col("confidence");
  const verdict = col("verdict");
  const out = new Map<
    string,
    { yes: number; no: number; unsure: number; blank: number }
  >();
  for (const r of body) {
    if (r.length <= 1 && (r[0] ?? "") === "") continue;
    const l = r[level] ?? "?";
    const s = out.get(l) ?? { yes: 0, no: 0, unsure: 0, blank: 0 };
    const v = (r[verdict] ?? "").trim().toLowerCase();
    if (v === "yes") s.yes++;
    else if (v === "no") s.no++;
    else if (v === "unsure") s.unsure++;
    else s.blank++;
    out.set(l, s);
  }
  return [...out].map(([l, s]) => ({ level: l, ...s }));
}

/**
 * Verdicts and notes already in a review sheet, by finding id, so writing the
 * sheet again keeps the review (ids are stable: kind and subject, no lines).
 */
export function reviewedById(
  rows: readonly string[][],
): Map<string, { verdict: string; note: string }> {
  const [header, ...body] = rows;
  const col = (name: string) => header?.indexOf(name) ?? -1;
  const [id, verdict, note] = [col("id"), col("verdict"), col("note")];
  const out = new Map<string, { verdict: string; note: string }>();
  for (const r of body) {
    const key = r[id] ?? "";
    const v = (r[verdict] ?? "").trim();
    if (key !== "" && v !== "")
      out.set(key, { verdict: v, note: r[note] ?? "" });
  }
  return out;
}

function main(): void {
  const { values } = parseArgs({
    options: {
      csv: { type: "string", default: "docs/benchmarks/findings-review.csv" },
    },
  });
  const scores = score(parseCsv(fs.readFileSync(values.csv, "utf8")));
  process.stdout.write(
    `${table(
      [
        "Confidence",
        "Yes",
        "No",
        "Unsure",
        "Not reviewed",
        "Precision (yes / (yes + no))",
      ],
      scores.map((s) => [
        s.level,
        String(s.yes),
        String(s.no),
        String(s.unsure),
        String(s.blank),
        s.yes + s.no === 0 ? "not measured" : pct(s.yes / (s.yes + s.no)),
      ]),
    )}\n`,
  );
}

if (process.argv[1]?.endsWith("findings-score.js") === true) main();
