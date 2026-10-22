const enabled = true;

export function run(): number {
  if (enabled) {
    return 1;
  } else {
    return 0;
  } // @E
}
