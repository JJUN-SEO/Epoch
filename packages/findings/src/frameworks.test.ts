import { describe, expect, it } from "vitest";
import { globMatcher } from "@epoch-dev/core";
import {
  FRAMEWORKS,
  detectFrameworks,
  frameworkMatcher,
} from "./frameworks.js";

describe("framework list", () => {
  it("validates, with unique ids, compiling globs and pinned GitHub sources", () => {
    expect(FRAMEWORKS.length).toBeGreaterThanOrEqual(8);
    expect(new Set(FRAMEWORKS.map((f) => f.id)).size).toBe(FRAMEWORKS.length);
    for (const f of FRAMEWORKS) {
      expect(() => globMatcher(f.conventions), f.id).not.toThrow();
      for (const s of f.sources) {
        // A blob URL pinned to a full commit, never a moving branch.
        expect(s, f.id).toMatch(
          /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/blob\/[0-9a-f]{40}\//,
        );
      }
    }
  });
});

describe("detectFrameworks", () => {
  it("detects by a manifest's dependencies and by marker files, per directory", () => {
    const detected = detectFrameworks(
      [
        { dir: "web", ecosystem: "npm", dependencies: ["react", "next"] },
        { dir: "", ecosystem: "npm", dependencies: ["vite"] },
        {
          dir: "api",
          ecosystem: "python",
          dependencies: ["django", "requests"],
        },
      ],
      ["api/manage.py", "tools/manage.py", "web/pages/index.tsx"],
    );
    expect(detected.map((d) => [d.id, d.dir, d.evidence])).toEqual([
      ["vite", "", "package.json depends on vite"],
      ["django", "api", "api/project depends on django"],
      ["django", "tools", "tools/manage.py exists"],
      ["nextjs", "web", "web/package.json depends on next"],
    ]);
  });

  it("does not cross ecosystems", () => {
    expect(
      detectFrameworks(
        [{ dir: "", ecosystem: "python", dependencies: ["next"] }],
        [],
      ),
    ).toEqual([]);
  });
});

describe("frameworkMatcher", () => {
  it("matches convention paths relative to the framework's directory", () => {
    const match = frameworkMatcher(
      detectFrameworks(
        [
          { dir: "site", ecosystem: "npm", dependencies: ["next"] },
          { dir: "", ecosystem: "npm", dependencies: ["@sveltejs/kit"] },
        ],
        ["backend/manage.py"],
      ),
    );
    const id = (p: string) => match(p)?.id;
    expect(id("site/pages/about.tsx")).toBe("nextjs");
    expect(id("site/src/app/page.tsx")).toBe("nextjs");
    expect(id("site/proxy.ts")).toBe("nextjs");
    expect(id("site/components/Nav.tsx")).toBeUndefined();
    expect(id("pages/about.tsx")).toBeUndefined();
    expect(id("src/routes/+page.ts")).toBe("sveltekit");
    expect(id("src/hooks.server.ts")).toBe("sveltekit");
    expect(id("backend/shop/migrations/0001_initial.py")).toBe("django");
    expect(id("backend/shop/management/commands/sync.py")).toBe("django");
    expect(id("backend/shop/admin.py")).toBe("django");
    expect(id("backend/shop/helpers.py")).toBeUndefined();
  });

  it("treats a Vite package's public/ folders as copied as-is", () => {
    const match = frameworkMatcher(
      detectFrameworks(
        [{ dir: "packages/browser", ecosystem: "npm", dependencies: ["vite"] }],
        [],
      ),
    );
    const id = (p: string) => match(p)?.id;
    // The public folder sits under the Vite root, which may be a subfolder.
    expect(id("packages/browser/src/client/public/injector.js")).toBe("vite");
    expect(id("packages/browser/public/icon.js")).toBe("vite");
    expect(id("packages/browser/src/client/client.ts")).toBeUndefined();
    expect(id("packages/other/public/icon.js")).toBeUndefined();
  });
});
