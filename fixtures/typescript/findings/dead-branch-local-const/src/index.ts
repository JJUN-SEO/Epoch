export function run(): number {
  const enabled = false;
  if (enabled) { // @C
    return 1;
  } // @E
  return 0;
}
