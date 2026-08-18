import type { SortDirection } from "@repo/app/shared/lib/table-utils";

/**
 * Epoch-ms for a timestamp string/Date, tolerant of a bad or missing value.
 * A `null`/`undefined` input, or one that parses to a non-finite time (an
 * invalid date), collapses to `0` so sorting stays deterministic rather than
 * propagating `NaN`. Shared by the trace-comments rail (which passes a
 * `createdAt` string) and the `use-trace-comments` merge logic (which may pass
 * an `updatedAt` that can be absent), so the accepted input is the union of
 * both call sites.
 */
export function parseTimestampMs(
  value: string | Date | null | undefined
): number {
  if (value == null) {
    return 0;
  }
  const timestamp = new Date(value).getTime();
  return Number.isFinite(timestamp) ? timestamp : 0;
}

/**
 * Returns a new array of `items` ordered by their `createdAt` time in `dir`,
 * breaking ties on the stable `id` so the order is fully deterministic. The
 * direction sign is applied to both the timestamp delta and the id tiebreak, so
 * a `desc` sort is the exact reverse of an `asc` sort. Pure: the input array is
 * not mutated.
 *
 * `dir` defaults to `"asc"`, which reproduces the ascending, id-tiebroken order
 * the trace-comments merge logic relies on for stability; the rail passes an
 * explicit direction to drive its newest-first / oldest-first toggle. Generic
 * over any `{ id; createdAt }` shape so both `TraceComment` and its display
 * variant `TraceCommentItem` can share one comparator.
 */
export function sortByCreatedAtThenId<
  T extends { id: string; createdAt: string },
>(items: readonly T[], dir: SortDirection = "asc"): T[] {
  const sign = dir === "asc" ? 1 : -1;
  return [...items].sort((a, b) => {
    const delta = parseTimestampMs(a.createdAt) - parseTimestampMs(b.createdAt);
    return sign * (delta === 0 ? a.id.localeCompare(b.id) : delta);
  });
}
