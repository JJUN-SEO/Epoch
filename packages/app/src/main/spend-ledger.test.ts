import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SpendLedger } from "./spend-ledger";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0))
    fs.rmSync(d, { recursive: true, force: true });
});
function file(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "epoch-spend-"));
  dirs.push(dir);
  return path.join(dir, "spend.json");
}

const limits = { capUsd: 1, sessionBudgetUsd: 0.5 };
const usage = { inputTokens: 1000, outputTokens: 100 };

describe("SpendLedger", () => {
  it("holds a request's worst case until it settles at its real cost", () => {
    const ledger = new SpendLedger(
      file(),
      () => new Date("2026-10-17T00:00:00Z"),
    );
    const hold = ledger.reserve(0.2, limits, true);
    if (typeof hold === "string") throw new Error(hold);
    expect(ledger.status(limits)).toMatchObject({
      month: "2026-10",
      monthUsd: 0,
      heldUsd: 0.2,
      capUsd: 1,
    });
    hold.settle(0.05, usage);
    expect(ledger.status(limits)).toMatchObject({
      monthUsd: 0.05,
      sessionUsd: 0.05,
      heldUsd: 0,
    });
  });

  it("refuses without a cap, past the cap, and past the session budget, counting holds", () => {
    const ledger = new SpendLedger(
      file(),
      () => new Date("2026-10-17T00:00:00Z"),
    );
    expect(ledger.reserve(0.1, { sessionBudgetUsd: 1 }, true)).toBe("no-cap");
    const a = ledger.reserve(0.4, limits, true);
    expect(typeof a).toBe("object");
    expect(ledger.reserve(0.2, limits, true)).toBe("session-budget");
    expect(ledger.reserve(0.7, { capUsd: 1, sessionBudgetUsd: 5 }, true)).toBe(
      "cap-reached",
    );
    if (typeof a !== "string") a.release();
    expect(ledger.status(limits).heldUsd).toBe(0);
  });

  it("lets a model on this machine run without a cap, at no cost", () => {
    const ledger = new SpendLedger(
      file(),
      () => new Date("2026-10-17T00:00:00Z"),
    );
    const hold = ledger.reserve(0, { sessionBudgetUsd: 0 }, false);
    if (typeof hold === "string") throw new Error(hold);
    hold.settle(0, usage);
    expect(ledger.status({ sessionBudgetUsd: 0 }).monthUsd).toBe(0);
  });

  it("keeps the month across restarts, starts a new month at zero, and resets on request", () => {
    const f = file();
    let now = new Date("2026-10-31T23:00:00Z");
    const first = new SpendLedger(f, () => now);
    const hold = first.reserve(0.3, limits, true);
    if (typeof hold === "string") throw new Error(hold);
    hold.settle(0.3, usage);
    const again = new SpendLedger(f, () => now);
    expect(again.status(limits)).toMatchObject({
      monthUsd: 0.3,
      sessionUsd: 0,
    });
    expect(fs.readFileSync(f, "utf8")).not.toMatch(/\.ts|src\//);
    now = new Date("2026-11-01T01:00:00Z");
    expect(again.status(limits)).toMatchObject({
      month: "2026-11",
      monthUsd: 0,
    });
    now = new Date("2026-10-31T23:30:00Z");
    const reset = new SpendLedger(f, () => now);
    reset.resetMonth();
    expect(reset.status(limits).monthUsd).toBe(0);
  });
});
