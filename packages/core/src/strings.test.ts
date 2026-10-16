import { describe, expect, it } from "vitest";
import {
  MAX_FILE_STRINGS,
  isKeyLikeLiteral,
  keyLikeStrings,
} from "./strings.js";

describe("isKeyLikeLiteral", () => {
  it("keeps event names, routes, topics and config keys", () => {
    for (const s of [
      "user.created",
      "orders-topic",
      "/api/users/:id",
      "/users/{id}",
      "FEATURE_FLAG",
      "app.settings.theme",
      "userCreated",
      "graph-canvas",
      "new-welcome-message",
      "billing:invoice.paid",
    ]) {
      expect(isKeyLikeLiteral(s), s).toBe(true);
    }
  });

  it("drops prose, short words, paths, URLs, extensions, MIME types and numbers", () => {
    for (const s of [
      "hello",
      "ab",
      "has space",
      "https://example.com/x",
      "mailto://a@b.c",
      "./local",
      "../up",
      ".ts",
      ".json",
      "text/plain",
      "application/json",
      "1.2.3",
      "2024-01-01",
      "%s-%d",
      "it's",
      'json:"id"',
      "a".repeat(99) + ".b", // 101 characters
      "",
    ]) {
      expect(isKeyLikeLiteral(s), s).toBe(false);
    }
  });
});

describe("keyLikeStrings", () => {
  it("keeps the first distinct key-like strings in source order, skips excluded ones, and sorts them", () => {
    expect(
      keyLikeStrings(
        [
          "user.updated",
          "hello",
          "./a",
          "user.created",
          "user.updated",
          "lodash/fp",
        ],
        new Set(["lodash/fp"]),
      ),
    ).toEqual(["user.created", "user.updated"]);
  });

  it("keeps at most MAX_FILE_STRINGS, chosen in source order", () => {
    const many = Array.from(
      { length: MAX_FILE_STRINGS + 10 },
      (_, i) => `key.${String(1000 - i)}`,
    );
    const kept = keyLikeStrings(many, new Set());
    expect(kept).toHaveLength(MAX_FILE_STRINGS);
    expect(kept).toEqual(many.slice(0, MAX_FILE_STRINGS).sort());
  });
});
