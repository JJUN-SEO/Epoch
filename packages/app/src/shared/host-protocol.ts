import { z } from "zod";

/*
 * Messages between main and the analysis host (a utilityProcess). Both sides
 * parse what they receive. A graph arrives already validated: the engine's
 * analyze() parses it with the Graph schema before returning it, so main does
 * not parse thousands of nodes a second time on its own thread.
 */

export const ProgressMessage = z.object({
  stage: z.enum(["discover", "parse", "resolve", "graph", "done"]),
  done: z.number().int().nonnegative(),
  total: z.number().int().nonnegative(),
});

export const HostRequest = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("analyze"),
    id: z.number().int().nonnegative(),
    /** Absolute path of a folder main has checked against the granted roots. */
    root: z.string().min(1),
  }),
]);
export type HostRequest = z.infer<typeof HostRequest>;

export const HostEvent = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("progress"),
    id: z.number().int().nonnegative(),
    progress: ProgressMessage,
  }),
  z.object({
    type: z.literal("result"),
    id: z.number().int().nonnegative(),
    graph: z.unknown(),
  }),
  z.object({
    type: z.literal("error"),
    id: z.number().int().nonnegative(),
    message: z.string(),
  }),
]);
export type HostEvent = z.infer<typeof HostEvent>;
