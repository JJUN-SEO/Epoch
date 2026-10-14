import { z } from "zod";
import { Line } from "./facts.js";

export const UnresolvedReason = z.enum([
  "dynamic-specifier",
  "not-found",
  "unsupported-syntax",
  "outside-project",
  "ambiguous",
]);
export type UnresolvedReason = z.infer<typeof UnresolvedReason>;

export const Resolution = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("file"), target: z.string().min(1) }),
  /** e.g. a Go package node. */
  z.strictObject({ kind: z.literal("package"), target: z.string().min(1) }),
  /** Third-party: recorded on the node, never materialized as a node. */
  z.strictObject({ kind: z.literal("external"), name: z.string().min(1) }),
  z.strictObject({
    kind: z.literal("unresolved"),
    reason: UnresolvedReason,
    pathPrefix: z.string().exactOptional(),
  }),
]);
export type Resolution = z.infer<typeof Resolution>;

export const UnresolvedImport = z.strictObject({
  from: z.string().min(1),
  specifier: z.string().nullable(),
  reason: UnresolvedReason,
  pathPrefix: z.string().exactOptional(),
  line: Line,
});
export type UnresolvedImport = z.infer<typeof UnresolvedImport>;
