export function theme(): string {
  return process.env.FEATURE_DARK_MODE === "1" ? "dark" : "light"; // @C
}
