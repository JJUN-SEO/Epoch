import { describe, expect, it } from "vitest";
import { egressAllows } from "./egress-policy";

describe("egressAllows (the egress session's own filter)", () => {
  it("lets model requests through online", () => {
    expect(egressAllows("https://api.anthropic.com/v1/messages", false)).toBe(
      true,
    );
    expect(egressAllows("http://127.0.0.1:11434/api/chat", false)).toBe(true);
    expect(egressAllows("https://api.openai.com/v1/responses", false)).toBe(
      true,
    );
    expect(
      egressAllows(
        "https://generativelanguage.googleapis.com/v1beta/models/m:generateContent",
        false,
      ),
    ).toBe(true);
  });

  it("keeps only the model on this machine offline", () => {
    expect(egressAllows("https://api.anthropic.com/v1/messages", true)).toBe(
      false,
    );
    expect(egressAllows("https://api.openai.com/v1/responses", true)).toBe(
      false,
    );
    expect(
      egressAllows("https://generativelanguage.googleapis.com/v1beta/", true),
    ).toBe(false);
    expect(egressAllows("http://127.0.0.1:11434/api/chat", true)).toBe(true);
  });

  it.each([
    "https://example.com/",
    "http://api.anthropic.com/v1/messages",
    "https://api.anthropic.com.evil.test/",
    "https://api.openai.com:8443/",
    "https://openai.com/",
    "https://googleapis.com/",
    "https://storage.googleapis.com/",
    "http://localhost:11434/api/chat",
    "http://127.0.0.1:11435/",
    "file:///etc/passwd",
    "ws://127.0.0.1:11434/",
    "not a url",
  ])("refuses %s", (url) => {
    expect(egressAllows(url, false)).toBe(false);
  });

  describe("the update check (ADR-018)", () => {
    const LATEST =
      "https://api.github.com/repos/JJUN-SEO/Epoch/releases/latest";

    it("allows one GET of the latest-release URL, online", () => {
      expect(egressAllows(LATEST, false, "GET")).toBe(true);
    });

    it("refuses it offline, and any other method", () => {
      expect(egressAllows(LATEST, true, "GET")).toBe(false);
      expect(egressAllows(LATEST, false, "POST")).toBe(false);
      expect(egressAllows(LATEST, false, "PUT")).toBe(false);
    });

    it.each([
      `${LATEST}?per_page=100`,
      `${LATEST}#x`,
      `${LATEST}/`,
      "https://api.github.com/repos/JJUN-SEO/Epoch/releases",
      "https://api.github.com/repos/JJUN-SEO/under-construction-/releases/latest",
      "https://api.github.com/repositories/1/releases/latest",
      "https://api.github.com/user",
      "http://api.github.com/repos/JJUN-SEO/Epoch/releases/latest",
      "https://api.github.com.evil.test/repos/JJUN-SEO/Epoch/releases/latest",
      "https://github.com/JJUN-SEO/Epoch/releases/latest",
      "https://uploads.github.com/repos/JJUN-SEO/Epoch/releases/latest",
    ])("refuses %s", (url) => {
      expect(egressAllows(url, false, "GET")).toBe(false);
    });
  });
});
