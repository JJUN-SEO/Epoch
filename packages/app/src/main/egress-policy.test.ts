import { describe, expect, it } from "vitest";
import { egressAllows } from "./egress-policy";

describe("egressAllows (the egress session's own filter)", () => {
  it("lets model requests through online", () => {
    expect(egressAllows("https://api.anthropic.com/v1/messages", false)).toBe(
      true,
    );
    expect(egressAllows("http://127.0.0.1:11434/api/chat", false)).toBe(true);
  });

  it("keeps only the model on this machine offline", () => {
    expect(egressAllows("https://api.anthropic.com/v1/messages", true)).toBe(
      false,
    );
    expect(egressAllows("http://127.0.0.1:11434/api/chat", true)).toBe(true);
  });

  it.each([
    "https://example.com/",
    "http://api.anthropic.com/v1/messages",
    "https://api.anthropic.com.evil.test/",
    "http://localhost:11434/api/chat",
    "http://127.0.0.1:11435/",
    "file:///etc/passwd",
    "ws://127.0.0.1:11434/",
    "not a url",
  ])("refuses %s", (url) => {
    expect(egressAllows(url, false)).toBe(false);
  });
});
