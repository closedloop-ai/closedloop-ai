import { STATUS_DISPLAY_ORDER } from "./status-grouping";

const COMBINED_STATUS_SORT_ORDER = new Map<string, number>(
  STATUS_DISPLAY_ORDER.map((status, index) => [status, index])
);

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
 * explicit `order` array to sort within a single vocabulary. Unknown statuses
 * sort after all known ones.
 */
export function compareStatusValues(
  a: string | null | undefined,
  b: string | null | undefined,
  order?: readonly string[]
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
  const sortOrder = order ? indexMapFor(order) : COMBINED_STATUS_SORT_ORDER;
  const unknownOrder = order ? order.length : STATUS_DISPLAY_ORDER.length;
  const aOrder = sortOrder.get(a) ?? unknownOrder;
  const bOrder = sortOrder.get(b) ?? unknownOrder;
  return aOrder - bOrder;
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
