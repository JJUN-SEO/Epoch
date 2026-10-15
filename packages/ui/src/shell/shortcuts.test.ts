import { describe, expect, it } from "vitest";
import { matches, shortcutLabel } from "./shortcuts";

const key = (k: string, mods: Partial<Record<string, boolean>> = {}) => ({
  key: k,
  code: "",
  metaKey: false,
  ctrlKey: false,
  altKey: false,
  shiftKey: false,
  ...mods,
});

describe("shortcuts", () => {
  it("maps Mod to ⌘ on macOS and Ctrl elsewhere", () => {
    const s = { mod: true, key: "k" };
    expect(matches(key("k", { metaKey: true }), s, true)).toBe(true);
    expect(matches(key("k", { ctrlKey: true }), s, true)).toBe(false);
    expect(matches(key("K", { ctrlKey: true }), s, false)).toBe(true);
    expect(matches(key("k", { metaKey: true }), s, false)).toBe(false);
  });

  it("requires exactly the listed modifiers", () => {
    expect(matches(key("f"), { key: "f" }, false)).toBe(true);
    expect(matches(key("f", { shiftKey: true }), { key: "f" }, false)).toBe(
      false,
    );
    expect(
      matches(
        key("b", { ctrlKey: true, altKey: true }),
        { mod: true, key: "b" },
        false,
      ),
    ).toBe(false);
  });

  it("matches layout-dependent keys by code", () => {
    const back = { mod: true, code: "BracketLeft" };
    expect(
      matches(
        { ...key("ü", { metaKey: true }), code: "BracketLeft" },
        back,
        true,
      ),
    ).toBe(true);
  });

  it("writes shortcuts the way each OS does", () => {
    expect(shortcutLabel({ mod: true, key: "k" }, true)).toBe("⌘K");
    expect(shortcutLabel({ mod: true, key: "k" }, false)).toBe("Ctrl+K");
    expect(shortcutLabel({ mod: true, alt: true, key: "b" }, true)).toBe("⌘⌥B");
    expect(shortcutLabel({ mod: true, code: "BracketLeft" }, false)).toBe(
      "Ctrl+[",
    );
    expect(shortcutLabel({ key: "f" }, false)).toBe("F");
    expect(shortcutLabel({ mod: true, alt: true, code: "KeyB" }, false)).toBe(
      "Ctrl+Alt+B",
    );
  });
});
