export const ENABLE_BETA = false;

export function run(): number {
  return ENABLE_BETA ? 1 : 0; // @C @E
}
