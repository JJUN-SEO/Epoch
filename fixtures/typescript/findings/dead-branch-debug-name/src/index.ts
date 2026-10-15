const DEBUG = false;

export function run(): number {
  if (DEBUG) { // @C
    console.log("debug");
  } // @E
  return 0;
}
