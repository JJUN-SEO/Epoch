import { describe, expect, it } from "vitest";
import { DEV_CSP, devCsp, withDevCsp } from "../dev-csp";

const html = `<head><meta
  http-equiv="Content-Security-Policy"
  content="default-src 'none'; script-src 'self'"
/></head>`;

describe("dev CSP", () => {
  it("replaces the policy in the meta tag", () => {
    expect(withDevCsp(html)).toContain(`content="${DEV_CSP}"`);
    expect(withDevCsp(html)).not.toContain(`script-src 'self'"`);
  });

  it("refuses a page without the meta tag rather than serving no policy", () => {
    expect(() => withDevCsp("<head></head>")).toThrow(/meta tag/);
  });

  it("applies to the dev server only, so builds keep the strict policy", () => {
    expect(devCsp().apply).toBe("serve");
  });
});
