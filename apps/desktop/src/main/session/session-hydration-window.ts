/**
 * ISS-6895: bounded-window hydration for the local session reads.
 *
 * The desktop list/usage/analytics reads fall back to hydrating sessions in JS
 * whenever a filter cannot be pushed into SQL (free-text search, the Repository
 * facet combined with a hydrated predicate, the local-only facets). That
 * hydration used to be bounded by TRUNCATING the matched id set to a ceiling, so
 * the summary folded only the newest N rows while the list — which pages before
 * hydrating and never truncates — reported the whole matched population. The two
 * disagreed, and the summary quietly under-reported.
 *
 * A cap is the wrong bound: it buys a bounded footprint by making a number
 * wrong. The bound belongs on how many rows are RESIDENT AT ONCE, not on how
 * many are counted. These helpers supply that: the matched id set is resolved in
 * full, then hydrated one {@link SESSION_HYDRATION_WINDOW}-sized window at a
 * time and folded into an accumulator whose size is keyed by dimension, so peak
 * residency stays exactly what the old ceiling allowed while the population is
 * complete. Each window is a separate awaited source call, so the main process
 * also regains control between windows instead of blocking on one huge hydrate.
 */

/**
 * How many sessions may be hydrated into JS AT ONCE.
 *
 * This is the FEA-3132 (A5b) / FEA-4286 ceiling, unchanged in value and in what
 * it protects: hydrating a session materializes its agents, events, links and
 * token usage, and an unbounded hydrate is the read-side allocator that co-peaks
 * with backfill in the FEA-2038 db-host OOM. What changed (ISS-6895) is its
 * SCOPE — it bounds one window, not the whole matched set, so it can no longer
 * decide how many sessions a total counts.
 */
export const SESSION_HYDRATION_WINDOW = 5000;

/**
 * Split an ordered id list into successive hydration windows. A generator so the
 * windows are never all materialized at once.
 */
export function* sessionHydrationWindows(
  ids: readonly string[],
  windowSize: number = SESSION_HYDRATION_WINDOW
): Generator<string[]> {
  // Clamp at BOTH ends: a non-finite or sub-1 window would either loop forever
  // or slice nothing, silently dropping the population this module exists to
  // preserve.
  const size = Number.isFinite(windowSize)
    ? Math.max(1, Math.floor(windowSize))
    : SESSION_HYDRATION_WINDOW;
  for (let start = 0; start < ids.length; start += size) {
    yield ids.slice(start, start + size);
  }
}

/**
 * A bounded "which ids land first in sort order" buffer.
 *
 * The list fallback needs one page out of the sorted matched set, and deciding
 * which rows those are requires seeing every match — but it does NOT require
 * RETAINING every match, and it does not require retaining a matched row's
 * PAYLOAD at all. Each window contributes one `{ id, key }` entry per matched
 * row; the buffer re-sorts and truncates back to `capacity` after every merge,
 * then the caller hydrates only the page's ids.
 *
 * Two properties this buys, both load-bearing:
 *   - a hydrated `SyncedAgentSession` (agents, events, links, token usage) is
 *     orders of magnitude larger than an `{ id, key }` pair, so a deep-offset
 *     page — `capacity` is the caller's `offset + limit`, and offset has no
 *     upper bound — cannot pin the matched population's PAYLOAD in memory. The
 *     buffer stays the same order of magnitude as the resolved id list the read
 *     already holds.
 *   - because the sort is stable, ties break on the row's position in the
 *     resolved order, and windows arrive in that order, truncating after every
 *     merge yields exactly the ids a single sort of the whole matched set would
 *     have put first.
 *
 * `compare` is null for a read with no sort: the resolved order already IS the
 * answer, so entries keep their insertion order and truncation keeps the first
 * `capacity`.
 */
export type OrderedPageIdWindow<TKey> = {
  merge: (candidates: readonly { id: string; key: TKey }[]) => void;
  pageIds: (offset: number, limit: number) => string[];
};

export function createOrderedPageIdWindow<TKey>(
  capacity: number,
  compare: ((a: TKey, b: TKey) => number) | null
): OrderedPageIdWindow<TKey> {
  // Clamp at both ends: `Math.min` alone would let a negative/NaN capacity
  // through and empty the page.
  const bound = Number.isFinite(capacity)
    ? Math.max(1, Math.floor(capacity))
    : 1;
  let entries: { id: string; key: TKey; position: number }[] = [];
  let resolvedPosition = 0;
  return {
    merge: (candidates) => {
      for (const candidate of candidates) {
        entries.push({ ...candidate, position: resolvedPosition });
        resolvedPosition += 1;
      }
      if (compare) {
        entries.sort((a, b) => {
          const byKey = compare(a.key, b.key);
          return byKey === 0 ? a.position - b.position : byKey;
        });
      }
      if (entries.length > bound) {
        entries = entries.slice(0, bound);
      }
    },
    pageIds: (offset, limit) =>
      entries.slice(offset, offset + limit).map((entry) => entry.id),
  };
}
