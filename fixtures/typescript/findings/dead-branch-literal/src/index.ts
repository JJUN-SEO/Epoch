export function run(): number {
  if (false) { // @C
    return 1;
  } // @E
  return 0;
}
