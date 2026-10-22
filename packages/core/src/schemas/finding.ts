import { z } from "zod";
import { Line } from "./facts.js";

export const FindingKind = z.enum([
  "dead-branch",
  "stale-flag",
  "unreachable-file",
]);
export type FindingKind = z.infer<typeof FindingKind>;

export const Confidence = z.enum(["high", "medium", "low"]);
export type Confidence = z.infer<typeof Confidence>;

export const Finding = z.strictObject({
  /** Stable: hash of kind + subject + discriminator. Never includes line numbers. */
  id: z.string().min(1),
  kind: FindingKind,
  /** Flag key, or repo-relative path. */
  subject: z.strictObject({
    type: z.enum(["flag", "file"]),
    name: z.string().min(1),
  }),
  confidence: Confidence,
  locations: z.array(
    z.strictObject({
      file: z.string().min(1),
      line: Line.exactOptional(),
      endLine: Line.exactOptional(),
    }),
  ),
  evidence: z.array(z.string()),
  caveats: z.array(z.string()),
  suggestedAction: z.string(),
  /** Names of the rubric caps that applied. */
  caps: z.array(z.string()),
});
export type Finding = z.infer<typeof Finding>;
