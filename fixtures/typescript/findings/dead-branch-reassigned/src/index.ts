let enabled = false;

export function toggle(): void {
  enabled = true;
}

export function run(): number {
  if (enabled) {
    return 1;
  }
  return 0;
}
