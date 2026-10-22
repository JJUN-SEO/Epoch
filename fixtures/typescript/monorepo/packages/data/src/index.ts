import { z } from "zod";
import seed from "./seed.json" with { type: "json" };
export const schema = z.object({});
export const data = seed;
