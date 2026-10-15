import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { isReachable, loadWindowState, saveWindowState } from "./window-state";

const screen = { x: 0, y: 0, width: 1920, height: 1080 };

describe("isReachable", () => {
  it("accepts a window whose top edge is on a display", () => {
    expect(
      isReachable({ x: 100, y: 100, width: 800, height: 600 }, [screen]),
    ).toBe(true);
    // Partly off screen, but the title bar can still be grabbed.
    expect(
      isReachable({ x: 1800, y: 50, width: 800, height: 600 }, [screen]),
    ).toBe(true);
  });

  it("refuses a window left on a display that is gone", () => {
    expect(
      isReachable({ x: 2500, y: 100, width: 800, height: 600 }, [screen]),
    ).toBe(false);
    expect(
      isReachable({ x: 100, y: -500, width: 800, height: 400 }, [screen]),
    ).toBe(false);
    const second = { x: 1920, y: 0, width: 1280, height: 1024 };
    expect(
      isReachable({ x: 2500, y: 100, width: 800, height: 600 }, [
        screen,
        second,
      ]),
    ).toBe(true);
  });
});

describe("loadWindowState and saveWindowState", () => {
  it("round-trips a valid state and ignores anything else", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "epoch-window-"));
    try {
      const file = path.join(dir, "nested", "window-state.json");
      expect(loadWindowState(file)).toBeUndefined();
      const state = {
        x: 10,
        y: 20,
        width: 1200,
        height: 800,
        maximized: false,
      };
      saveWindowState(file, state);
      expect(loadWindowState(file)).toEqual(state);
      fs.writeFileSync(file, JSON.stringify({ ...state, width: 5 }));
      expect(loadWindowState(file)).toBeUndefined();
      fs.writeFileSync(file, "{");
      expect(loadWindowState(file)).toBeUndefined();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
