/** Storage for derived outputs keyed by the hash of their inputs (CacheStore implements it). */
export interface DerivedStore {
  getDerived(
    namespace: string,
    key: string,
  ): { inputHash: string; value: unknown } | undefined;
  putDerived(
    namespace: string,
    key: string,
    inputHash: string,
    value: unknown,
  ): void;
}

/**
 * Early cutoff (CLAUDE.md "Local cache"): if a recomputed input equals the
 * previous one, reuse the stored output and stop propagating. `parse`
 * validates the stored value (a zod schema's parse, typically); a stored value
 * that no longer validates is recomputed. Used by M6 scores and M7 summaries.
 */
export function recomputeIfChanged<T>(
  store: DerivedStore,
  namespace: string,
  key: string,
  inputHash: string,
  compute: () => T,
  parse: (value: unknown) => T,
): { value: T; recomputed: boolean } {
  const previous = store.getDerived(namespace, key);
  if (previous?.inputHash === inputHash) {
    try {
      return { value: parse(previous.value), recomputed: false };
    } catch {
      // stale or corrupt entry: fall through and recompute
    }
  }
  const value = compute();
  store.putDerived(namespace, key, inputHash, value);
  return { value, recomputed: true };
}
