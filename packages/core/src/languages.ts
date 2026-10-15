/**
 * The support tier of each source language, keyed by GraphNode.language
 * (CLAUDE.md principle 9, "Language support tiers"). The adapters declare
 * their tier; this copy is for code that cannot load adapters, such as the
 * renderer and the static demo. An engine test keeps the two in step.
 */
export const LANGUAGE_TIERS: Readonly<Record<string, "A" | "B">> = {
  typescript: "A",
  javascript: "A",
  python: "A",
  go: "A",
};
