import fs from "node:fs";
import path from "node:path";
import { z } from "zod";

/** The project window's last size and position, kept in Epoch's app data. */
export const WindowState = z.object({
  x: z.number().int(),
  y: z.number().int(),
  width: z.number().int().min(400).max(20_000),
  height: z.number().int().min(300).max(20_000),
  maximized: z.boolean(),
});
export type WindowState = z.infer<typeof WindowState>;

export interface Rect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/**
 * True if enough of the window's top edge lies on some display to grab it
 * (a display may have been unplugged since it was saved).
 */
export function isReachable(state: Rect, workAreas: readonly Rect[]): boolean {
  const grab = { x: state.x, y: state.y, width: state.width, height: 40 };
  return workAreas.some((a) => {
    const w =
      Math.min(grab.x + grab.width, a.x + a.width) - Math.max(grab.x, a.x);
    const h =
      Math.min(grab.y + grab.height, a.y + a.height) - Math.max(grab.y, a.y);
    return w >= 100 && h >= 20;
  });
}

export function loadWindowState(file: string): WindowState | undefined {
  try {
    const parsed = WindowState.safeParse(
      JSON.parse(fs.readFileSync(file, "utf8")),
    );
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

export function saveWindowState(file: string, state: WindowState): void {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(state), { mode: 0o600 });
  } catch {
    // Remembering the window is a convenience; never fail closing over it.
  }
}
