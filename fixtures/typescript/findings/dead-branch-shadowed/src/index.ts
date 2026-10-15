export function run(): number {
  const enabled = false;
  const check = (enabled: boolean) => (enabled ? 1 : 0);
  return check(true);
}
