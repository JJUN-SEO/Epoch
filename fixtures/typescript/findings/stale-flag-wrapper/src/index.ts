import { featureEnabled } from "./flags";

export function search(): number {
  return featureEnabled("beta-search") ? 1 : 0; // @C
}
