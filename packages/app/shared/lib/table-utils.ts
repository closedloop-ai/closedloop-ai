import { parseDateLocal } from "./date-utils";

export type SortDirection = "asc" | "desc";

export type SortConfig<T> = {
  key: keyof T | string;
  /**
   * An ASCENDING comparator. Its result is negated wholesale for a descending
   * sort, so it cannot pin a value to one end of the column in both directions
   * — use `directedComparator` when it must.
   */
  comparator?: (a: T, b: T) => number;
  /**
   * A comparator that is handed the direction and whose result is used
   * VERBATIM — never negated.
   *
   * The built-in key path below places `null`/`undefined` last by returning
   * before the negation, so unknown values stay at the bottom whichever way the
   * column is sorted. A `comparator` cannot express that: negating its result
   * flips its null placement too, floating "we don't know" above the largest
   * real value on a descending sort. A column with its own comparator AND
   * unknown values it must keep at the bottom needs this field.
   * `compareCountValues` and `compareMonoIds` (`@repo/design-system`) are the
   * reference implementations. Takes precedence over `comparator`.
   */
  directedComparator?: (a: T, b: T, direction: SortDirection) => number;
  columnType?: "string" | "number" | "date";
  /**
   * An ASCENDING-only key read when the primary comparison ties, so equal
   * values land in the same order every render (ISS-9345, PRD-706 R10).
   *
   * Never negated. A tie-break that flips with the direction is not a
   * tie-break — it is a second sort key, and it makes the two directions
   * disagree about which of two equal rows comes first. Sorting by a coarse
   * column (priority, status, a date with no time) is where this bites: V8's
   * sort is stable, so without a tie-break the order inside a tie is whatever
   * order the CALLER happened to hand in, which a filter, a page or a
   * server-side ordering change silently rewrites.
   */
  tieBreak?: (a: T, b: T) => number;
};

/**
 * The tie-break, applied only once the primary comparison has actually tied.
 *
 * Ordered AFTER the direction has been resolved and applied, and returned
 * unnegated, so ascending and descending agree on the order within a tie.
 */
function breakTie<T>(a: T, b: T, config: SortConfig<T>): number {
  return config.tieBreak ? config.tieBreak(a, b) : 0;
}

function compareSortValues<T>(
  a: T,
  b: T,
  config: SortConfig<T>,
  direction: SortDirection
): number {
  const primary = comparePrimary(a, b, config, direction);
  return primary === 0 ? breakTie(a, b, config) : primary;
}

function comparePrimary<T>(
  a: T,
  b: T,
  config: SortConfig<T>,
  direction: SortDirection
): number {
  if (config.directedComparator) {
    return config.directedComparator(a, b, direction);
  }

  if (config.comparator) {
    const result = config.comparator(a, b);
    return direction === "asc" ? result : -result;
  }

  return compareByKey(a, b, config, direction);
}

export function sortItems<T>(
  items: T[],
  config: SortConfig<T>,
  direction: SortDirection
): T[] {
  return [...items].sort((a, b) => compareSortValues(a, b, config, direction));
}

export function sortTableData<T>(
  items: T[],
  sortBy: string | null,
  configs: Record<string, SortConfig<T>>,
  sortDir: SortDirection
): T[] {
  if (!sortBy) {
    return items;
  }
  const config = configs[sortBy] as SortConfig<T> | undefined;
  if (!config) {
    return items;
  }
  return sortItems(items, config, sortDir);
}

/**
 * The built-in path: read `config.key` off both rows and order by
 * `columnType`. The nulls-last block returns BEFORE any of the direction
 * negations further down, which is what keeps unknown values at the bottom
 * whichever way the column is sorted — the property a `comparator` cannot
 * reproduce and `directedComparator` exists to give back. An UNPARSEABLE date
 * is the same kind of unknown and is handled the same way; see
 * {@link compareDates}.
 */
function compareByKey<T>(
  a: T,
  b: T,
  config: SortConfig<T>,
  direction: SortDirection
): number {
  const aValue = (a as Record<string, unknown>)[config.key as string];
  const bValue = (b as Record<string, unknown>)[config.key as string];

  const aNull = aValue == null;
  const bNull = bValue == null;
  if (aNull && bNull) {
    return 0;
  }
  if (aNull) {
    return 1;
  }
  if (bNull) {
    return -1;
  }

  if (config.columnType === "date") {
    return compareDates(aValue, bValue, direction);
  }

  if (config.columnType === "number") {
    const aNum = aValue as number;
    const bNum = bValue as number;
    const result = aNum - bNum;
    return direction === "asc" ? result : -result;
  }

  const aStr = String(aValue ?? "");
  const bStr = String(bValue ?? "");
  const result = aStr.localeCompare(bStr);
  return direction === "asc" ? result : -result;
}

/**
 * The `columnType: "date"` comparison, with an unparseable value treated as an
 * unknown rather than as a number.
 *
 * `Invalid Date.getTime()` is NaN, and `NaN - NaN` is NaN. `Array#sort` reads
 * that as 0 while `primary === 0` is false, so the row pair is left in input
 * order AND the tie-break never runs — the determinism the config promises is
 * lost exactly on the bad data that needs it most. Routing an unreadable date
 * to the bottom in BOTH directions keeps it consistent with the nulls-last
 * block above: "we could not read this" is the same answer as "there is
 * nothing here", and neither outranks a real date.
 */
function compareDates(
  aValue: unknown,
  bValue: unknown,
  direction: SortDirection
): number {
  const aTime = sortableTime(aValue);
  const bTime = sortableTime(bValue);
  const aUnknown = Number.isNaN(aTime);
  const bUnknown = Number.isNaN(bTime);
  if (aUnknown && bUnknown) {
    return 0;
  }
  if (aUnknown) {
    return 1;
  }
  if (bUnknown) {
    return -1;
  }

  const result = aTime - bTime;
  return direction === "asc" ? result : -result;
}

function sortableTime(value: unknown): number {
  const date =
    typeof value === "string" ? parseDateLocal(value) : (value as Date);
  return date.getTime();
}
