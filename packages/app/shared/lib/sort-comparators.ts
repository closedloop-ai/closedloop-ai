import { statusDisplayRank } from "@repo/api/src/types/artifact-status-display-order";

// Memoize the index Map per `order` array reference so a comparator passed to
// Array.prototype.sort (O(n log n) calls) builds it once, not on every call.
const ORDER_INDEX_CACHE = new WeakMap<readonly string[], Map<string, number>>();

function indexMapFor(order: readonly string[]): Map<string, number> {
  let map = ORDER_INDEX_CACHE.get(order);
  if (!map) {
    map = new Map<string, number>(
      order.map((status, index) => [status, index])
    );
    ORDER_INDEX_CACHE.set(order, map);
  }
  return map;
}

/**
 * Compare two status strings by display order. Defaults to the combined
 * Document+Feature order used by the mixed documents table (PRD-495); pass an
 * explicit `order` array to sort within a single vocabulary. Unknown statuses —
 * and rows with no status — sort after all known ones.
 *
 * ISS-9669: the default path delegates to {@link statusDisplayRank} rather than
 * keeping its own index map, because the documents table's status GROUPING
 * ranks sections with that same function. Two private derivations of "where
 * does an unknown status go" is how one table came to sort a row last and group
 * it first.
 */
export function compareStatusValues(
  a: string | null | undefined,
  b: string | null | undefined,
  order?: readonly string[]
): number {
  if (!order) {
    return statusDisplayRank(a) - statusDisplayRank(b);
  }
  return rankWithin(order, a) - rankWithin(order, b);
}

export function compareSlugValues(
  a: string | null | undefined,
  b: string | null | undefined
): number {
  if (!(a || b)) {
    return 0;
  }
  if (!a) {
    return 1;
  }
  if (!b) {
    return -1;
  }
  return a.localeCompare(b, undefined, { numeric: true });
}

export const NAME_SORT_OPTIONS = [
  { key: "title", label: "Name" },
  { key: "status", label: "Status" },
  { key: "slug", label: "ID" },
] as const;

/** Position of `status` in an explicit single-vocabulary order; misses rank last. */
function rankWithin(
  order: readonly string[],
  status: string | null | undefined
): number {
  if (!status) {
    return order.length;
  }
  return indexMapFor(order).get(status) ?? order.length;
}
