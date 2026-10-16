import { describe, expect, it } from "vitest";
import { SpendCap, SpendCapReached, costOf, estimateTokens } from "./cost.js";
import { NetworkBlockedError, createNet } from "./net.js";
import { isSecretPath } from "./secrets.js";

const ok = () =>
  Promise.resolve(new Response("{}", { status: 200 })) as ReturnType<
    typeof fetch
  >;

describe("createNet", () => {
  it("sends only to allowed origins, and records origin and path only", async () => {
    const net = createNet({
      offline: false,
      allow: ["https://api.anthropic.com"],
      fetch: ok,
    });
    await net.fetch("https://api.anthropic.com/v1/messages?beta=true", {
      method: "POST",
    });
    await expect(net.fetch("https://evil.example/v1/messages")).rejects.toThrow(
      NetworkBlockedError,
    );
    await expect(
      net.fetch("http://api.anthropic.com/v1/messages"),
    ).rejects.toThrow("not an allowed destination");
    expect(net.sent()).toEqual(["https://api.anthropic.com/v1/messages"]);
  });

  it("refuses everything when offline", async () => {
    let called = 0;
    const net = createNet({
      offline: true,
      allow: ["http://127.0.0.1:11434"],
      fetch: () => {
        called++;
        return ok();
      },
    });
    await expect(net.fetch("http://127.0.0.1:11434/api/chat")).rejects.toThrow(
      "offline",
    );
    expect(called).toBe(0);
    expect(net.sent()).toEqual([]);
  });
});

describe("isSecretPath", () => {
  it.each([
    ".env",
    "config/.env.production",
    "deploy/prod.env",
    "certs/server.PEM",
    "keys/id_ed25519.pub",
    ".aws/credentials",
    "src/secrets.ts",
    "gcp/service-account-prod.json",
    "home/.npmrc",
  ])("treats %s as a secret", (p) => {
    expect(isSecretPath(p)).toBe(true);
  });

  it.each(["src/env.ts", "src/keyboard.ts", "README.md", "src/tokenizer.ts"])(
    "lets %s through",
    (p) => {
      expect(isSecretPath(p)).toBe(false);
    },
  );
});

describe("SpendCap", () => {
  const prices = { inputPerMTok: 1, outputPerMTok: 5 };

  it("costs usage at the user's prices", () => {
    expect(costOf({ inputTokens: 1_000_000, outputTokens: 0 }, prices)).toBe(1);
    expect(costOf({ inputTokens: 0, outputTokens: 200_000 }, prices)).toBe(1);
  });

  it("refuses a request whose worst case would pass the cap, and counts what was spent", () => {
    const cap = new SpendCap(0.01, prices);
    cap.reserve({ inputTokens: 5000, outputTokens: 1000 }); // $0.01: allowed
    cap.record({ inputTokens: 4000, outputTokens: 200 }); // $0.005 spent
    expect(cap.spentUsd).toBeCloseTo(0.005, 10);
    expect(() => {
      cap.reserve({ inputTokens: 5000, outputTokens: 1000 });
    }).toThrow(SpendCapReached);
  });

  it("estimates tokens high, from characters alone", () => {
    expect(estimateTokens("abcdefgh")).toBe(4);
    expect(estimateTokens("")).toBe(0);
  });
});
