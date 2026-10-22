import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  APP_ENTRY_URL,
  CONTENT_SECURITY_POLICY,
  devServerOrigin,
  isAllowedExternalUrl,
  isAllowedRequest,
  isUiUrl,
  mimeType,
  resolveUiAsset,
} from "./policy";

describe("CONTENT_SECURITY_POLICY", () => {
  it("matches the meta tag the UI ships (the static demo site relies on it)", () => {
    const html = readFileSync(
      new URL("../../../ui/index.html", import.meta.url),
      "utf8",
    );
    const meta =
      /http-equiv="Content-Security-Policy"\s+content="([^"]*)"/.exec(html);
    expect(meta?.[1]).toBe(CONTENT_SECURITY_POLICY);
  });

  it("allows nothing by default and no inline or eval script", () => {
    expect(CONTENT_SECURITY_POLICY).toMatch(/^default-src 'none';/);
    expect(CONTENT_SECURITY_POLICY).not.toMatch(/unsafe-inline|unsafe-eval/);
    expect(CONTENT_SECURITY_POLICY).not.toMatch(/https?:|\*/);
  });
});

describe("isAllowedExternalUrl", () => {
  it.each([
    "https://github.com/JJUN-SEO/Epoch/releases/tag/v1.2.3",
    "https://github.com/",
  ])("allows %s", (url) => {
    expect(isAllowedExternalUrl(url)).toBe(true);
  });

  it.each([
    "http://github.com/", // not https
    "https://evil.example/",
    "https://github.com.evil.example/",
    "https://user:pw@github.com/",
    "https://github.com:8443/",
    "file:///etc/passwd",
    "javascript:alert(1)",
    "epoch://app/index.html",
    "not a url",
  ])("refuses %s", (url) => {
    expect(isAllowedExternalUrl(url)).toBe(false);
  });
});

describe("devServerOrigin", () => {
  it("accepts loopback http only", () => {
    expect(devServerOrigin("http://localhost:5173")).toBe(
      "http://localhost:5173",
    );
    expect(devServerOrigin("http://127.0.0.1:5173/")).toBe(
      "http://127.0.0.1:5173",
    );
    expect(devServerOrigin("https://localhost:5173")).toBeUndefined();
    expect(devServerOrigin("http://example.com")).toBeUndefined();
    expect(devServerOrigin(undefined)).toBeUndefined();
    expect(devServerOrigin("::")).toBeUndefined();
  });
});

describe("isUiUrl and isAllowedRequest", () => {
  const dev = "http://localhost:5173";

  it("accepts the app origin, and the dev server only when given", () => {
    expect(isUiUrl(APP_ENTRY_URL)).toBe(true);
    expect(isUiUrl("epoch://other/index.html")).toBe(false);
    expect(isUiUrl("http://localhost:5173/")).toBe(false);
    expect(isUiUrl("http://localhost:5173/", dev)).toBe(true);
    expect(isUiUrl("http://localhost:5174/", dev)).toBe(false);
  });

  it("allows only UI, DevTools and the dev server's WebSocket", () => {
    expect(isAllowedRequest("epoch://app/assets/index.js")).toBe(true);
    expect(isAllowedRequest("devtools://devtools/bundled/x.html")).toBe(true);
    expect(isAllowedRequest("ws://localhost:5173/")).toBe(false);
    expect(isAllowedRequest("ws://localhost:5173/", dev)).toBe(true);
    expect(isAllowedRequest("ws://localhost:9999/", dev)).toBe(false);
    for (const url of [
      "https://example.com/",
      "http://localhost:5173/",
      "file:///etc/passwd",
      "wss://example.com/",
      "garbage",
    ]) {
      expect(isAllowedRequest(url), url).toBe(false);
    }
  });
});

describe("resolveUiAsset", () => {
  const root = path.resolve("/opt/epoch/out/renderer");

  it("maps app URLs to files inside the renderer directory", () => {
    expect(resolveUiAsset(root, "epoch://app/")).toBe(
      path.join(root, "index.html"),
    );
    expect(resolveUiAsset(root, "epoch://app/assets/index-1.js?x=1")).toBe(
      path.join(root, "assets", "index-1.js"),
    );
    expect(resolveUiAsset(root, "epoch://app/a%20b.css")).toBe(
      path.join(root, "a b.css"),
    );
  });

  it("keeps dot segments inside (the URL parser normalizes them first)", () => {
    expect(resolveUiAsset(root, "epoch://app/%2e%2e/%2e%2e/etc/passwd")).toBe(
      path.join(root, "etc", "passwd"),
    );
  });

  it.each([
    "epoch://app/..%2f..%2fsecret",
    "epoch://app/%2e%2e%5csecret",
    "epoch://app/a%00.js",
    "epoch://app/%E0%A4%A",
    "epoch://other/index.html",
    "file:///etc/passwd",
    "https://app/index.html",
  ])("refuses %s", (url) => {
    expect(resolveUiAsset(root, url)).toBeUndefined();
  });
});

describe("mimeType", () => {
  it("knows the bundle's file types and falls back to octet-stream", () => {
    expect(mimeType("index.html")).toBe("text/html; charset=utf-8");
    expect(mimeType("a/B.JS")).toBe("text/javascript; charset=utf-8");
    expect(mimeType("x.unknown")).toBe("application/octet-stream");
  });
});
