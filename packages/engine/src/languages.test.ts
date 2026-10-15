import { describe, expect, it } from "vitest";
import { LANGUAGE_TIERS } from "@epoch-dev/core";
import { DEFAULT_REGISTRATIONS } from "./registrations.js";

describe("LANGUAGE_TIERS", () => {
  it("matches the tier every adapter declares, for every language it produces", () => {
    const produced: Record<string, string> = {};
    for (const reg of DEFAULT_REGISTRATIONS) {
      for (const ext of reg.adapter.extensions) {
        produced[reg.languageFor(`file${ext}`)] = reg.adapter.tier;
      }
    }
    expect(LANGUAGE_TIERS).toEqual(produced);
  });
});
