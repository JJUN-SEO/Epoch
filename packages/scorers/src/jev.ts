/*
 * JevScorer (CLAUDE.md "RelationScorer"): TypeSafe AI's Jev, early access.
 * Its API is built only from its current docs (docs.typesafe.ai), which
 * could not be read from the build environment, so this is the stub
 * PLAN.md asks for: it is never run, and reports say "not run".
 */

export const JEV_STATUS =
  "not built: Jev's docs (docs.typesafe.ai) could not be read, and its API is never written from memory";

export function jevUnavailable(): never {
  throw new Error(`The Jev scorer is ${JEV_STATUS}.`);
}
