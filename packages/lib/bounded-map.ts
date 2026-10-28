/**
 * @file bounded-map.ts
 * @description A `Map` that can never hold more than a fixed number of entries,
 * for the long-lived memoization and rate-limiter maps that accumulate keys from
 * external input.
 *
 * ISS-9678 folded `apps/api/lib/bounded-cache.ts`'s `BoundedCache` onto this
 * class: the two were the same primitive in two apps, and only this one rejected
 * a cap it could not honor. An app may not import another app's `lib/`, so the
 * single copy lives here, where both the cloud BFF and the desktop main process
 * can reach it.
 *
 * `apps/desktop/src/main/sync/AGENTS.md` invariant 10 requires every in-memory
 * set fed by external input to carry an explicit cap with an eviction policy, and
 * that eviction "degrade to re-discovered later, never to lost". This is the
 * shape for the caches where that condition holds by construction: every consumer
 * re-derives an evicted entry on the next miss, so an eviction costs one
 * recomputation and can never change an answer.
 *
 * It is deliberately NOT the shape for a map where the ENTRY IS the bound — a
 * retry budget, a stall clock, a dead-letter backoff row. Evicting one of those
 * hands its subject a fresh ceiling. Those cap ADMISSION instead; do not reach
 * for this class there.
 *
 * Eviction order is oldest WRITE first, not least-recently-READ: `set` re-inserts
 * an existing key so a rewrite moves it to the back, while `get` is left as
 * `Map`'s own so a hit stays pure bookkeeping. A consumer that needs read-touch
 * LRU or a TTL wants its own policy, not this class — `attribution-path-memo.ts`
 * and `agent-component-sync-dead-letter.ts` in the desktop main process are both
 * such cases and are deliberately not built on it.
 *
 * Subclassing `Map` rather than wrapping one is what keeps the diff at the
 * construction site: a consumer may declare its field as `Map`, and a subclass
 * satisfies that, so no reader, writer, or `.clear()` changes. One consequence is
 * worth knowing: a `BoundedMap` sent through `structuredClone` (the desktop
 * db-host `utilityProcess` boundary) arrives as a PLAIN `Map`, so a cap protects
 * the instance it was constructed on, not a copy that crossed a process boundary.
 */

/** A `Map` that evicts its oldest write once `maxEntries` would be exceeded. */
export class BoundedMap<K, V> extends Map<K, V> {
  private readonly maxEntries: number;

  /**
   * @param maxEntries hard ceiling on `size`. Rejected unless it is a safe
   * integer of at least 1: a fractional, non-finite, negative, zero, or
   * past-safe-range cap is a cap this class cannot honor, and silently coercing
   * one would leave a map that reads as bounded and is not. `NaN` is the reason
   * this is a throw rather than a clamp — every `size >= NaN` comparison is
   * false, so a coerced `NaN` cap grows without limit and looks healthy.
   */
  constructor(maxEntries: number) {
    if (!Number.isSafeInteger(maxEntries) || maxEntries < 1) {
      throw new RangeError(
        `BoundedMap needs a safe integer cap of at least 1; got ${String(maxEntries)}`
      );
    }
    super();
    this.maxEntries = maxEntries;
  }

  override set(key: K, value: V): this {
    // Delete first so a rewrite refreshes the key's position instead of leaving
    // it at the front, where the next eviction would take the entry that was
    // just proven live.
    this.delete(key);
    if (this.size >= this.maxEntries) {
      const oldest = this.keys().next();
      if (!oldest.done) {
        this.delete(oldest.value);
      }
    }
    return super.set(key, value);
  }
}
