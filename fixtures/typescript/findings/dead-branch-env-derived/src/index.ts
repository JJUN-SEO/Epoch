const enabled = process.env.FEATURE_X === "1";

export function run(): number {
  if (enabled) {
    return 1;
  }
  return 0;
}
