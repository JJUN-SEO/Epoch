/*
 * Release versions as the update check compares them (ADR-018): plain
 * MAJOR.MINOR.PATCH, optionally with a leading "v" (a tag name). Anything
 * else, pre-releases included, is not a version Epoch offers.
 */

export type Version = readonly [number, number, number];

const VERSION = /^v?(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})$/;

export function parseVersion(text: string): Version | undefined {
  const m = VERSION.exec(text);
  if (!m) return undefined;
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

/** Whether `latest` is a newer version than `current`; false if either is not one. */
export function isNewer(latest: string, current: string): boolean {
  const a = parseVersion(latest);
  const b = parseVersion(current);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i++) {
    const [x, y] = [a[i] ?? 0, b[i] ?? 0];
    if (x !== y) return x > y;
  }
  return false;
}
