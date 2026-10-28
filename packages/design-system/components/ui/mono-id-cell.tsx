"use client";

import { cn } from "@closedloop-ai/design-system/lib/utils";
import { CHIP_FOCUS_RING_CLASS } from "./chip";
import { GridEmptyValue } from "./grid-table-card";
import type { SortDirection } from "./sortable-column-header";

const SEGMENT_PATTERN = /\d+|\D+/g;
const DIGITS_ONLY_PATTERN = /^\d+$/;
const LEADING_ZEROS_PATTERN = /^0+(?=\d)/;

/**
 * The shared cell for a short machine identifier — a version, a commit hash, a
 * build number.
 *
 * Monospaced so digit columns line up down the column. The accessible name is
 * "{label} {value}", because a bare `4f2a1c` names nothing on its own (WCAG
 * 1.1.1); the non-interactive form carries it as an `sr-only` sibling rather
 * than an `aria-label`, which is prohibited on the generic role a `<span>`
 * has. Non-interactive until a caller supplies `onSelect`.
 *
 * Empty and unknown are one state: an identifier has no "zero" to be confused
 * with a missing one. Sort with `compareMonoIds`, filter by substring, and do
 * not add inline editing — an identifier is assigned, never typed.
 *
 * Does not subsume the artifact slug, which renders inside `NameCell` as part
 * of a composite lead rather than as a standalone cell.
 *
 * `isEmptyCellValue` matches on element TYPE and so cannot see the sentinel
 * this component produces internally. A `renderCell` that must let
 * `GridTableCard` drop the row calls `isMonoIdCellEmpty` and returns
 * `GridEmptyValue` itself.
 */
export function MonoIdCell({
  value,
  label,
  onSelect,
  alignEnd = false,
  className,
}: Readonly<MonoIdCellProps>) {
  if (!value) {
    return <GridEmptyValue alignEnd={alignEnd} title={`No ${label}`} />;
  }

  const accessibleName = `${label} ${value}`;
  const textClassName = cn(
    "truncate font-mono text-sm",
    alignEnd && "ml-auto",
    className
  );

  if (onSelect) {
    return (
      <button
        aria-label={accessibleName}
        className={cn(
          textClassName,
          "rounded-md text-left hover:underline",
          CHIP_FOCUS_RING_CLASS
        )}
        onClick={onSelect}
        title={value}
        type="button"
      >
        {value}
      </button>
    );
  }

  // A clipped `4f2a1c9` is not a shorter identifier, it is a different one,
  // so the full value stays recoverable on hover.
  return (
    <span className={textClassName} title={value}>
      <span aria-hidden>{value}</span>
      <span className="sr-only">{accessibleName}</span>
    </span>
  );
}

/**
 * True when `MonoIdCell` would render the shared empty value. Call it from a
 * `renderCell` and return `GridEmptyValue` directly when it holds, so the
 * narrow-surface card can drop the row (see the component docstring).
 */
export function isMonoIdCellEmpty(value: string | null | undefined): boolean {
  return !value;
}

/**
 * Natural-order comparator for `MonoIdCell` values.
 *
 * Digit runs compare numerically and text runs lexically, which is what makes
 * `v1.9` sort before `v1.10` instead of after it. Empty and missing values sort
 * last in BOTH directions — "we have no identifier" is not the largest
 * identifier.
 *
 * That fixed placement is why this takes `direction` and returns an already
 * directed result. Wire it into a table through `SortConfig.directedComparator`
 * (`packages/app/shared/lib/table-utils.ts`), which passes the direction and
 * uses the result verbatim. Wiring it as a plain `comparator` instead is a bug:
 * that branch negates the whole result for a descending sort, which flips the
 * missing identifiers to the top.
 */
export function compareMonoIds(
  a: string | null | undefined,
  b: string | null | undefined,
  direction: SortDirection = "asc"
): number {
  const left = a ?? "";
  const right = b ?? "";
  if (!(left || right)) {
    return 0;
  }
  if (!left) {
    return 1;
  }
  if (!right) {
    return -1;
  }
  const ascending = compareSegments(segmentsOf(left), segmentsOf(right));
  return direction === "desc" ? -ascending : ascending;
}

export type MonoIdCellProps = {
  /** The identifier as it should read: `v1.10`, `4f2a1c`, `build-284`. */
  value: string | null | undefined;
  /**
   * What kind of identifier this is ("Version", "Commit"). Builds the
   * accessible name so an opaque string is announced with its meaning
   * (WCAG 1.1.1), and names the empty state.
   */
  label: string;
  /** Makes the value a button. Omit to render non-interactive. */
  onSelect?: () => void;
  alignEnd?: boolean;
  className?: string;
};

/** Splits `v1.10` into `["v", "1", ".", "10"]`. */
function segmentsOf(value: string): string[] {
  return value.match(SEGMENT_PATTERN) ?? [];
}

function compareSegments(left: string[], right: string[]): number {
  const shared = Math.min(left.length, right.length);
  for (let index = 0; index < shared; index += 1) {
    const result = compareSegment(left[index], right[index]);
    if (result !== 0) {
      return result;
    }
  }
  return left.length - right.length;
}

function compareSegment(left: string, right: string): number {
  const bothNumeric =
    DIGITS_ONLY_PATTERN.test(left) && DIGITS_ONLY_PATTERN.test(right);
  if (bothNumeric) {
    return compareDigitRuns(left, right);
  }
  if (left === right) {
    return 0;
  }
  return left < right ? -1 : 1;
}

/**
 * Compares two digit runs as arbitrary-precision decimals. `Number` cannot be
 * used here: a build or version id may carry a digit run past
 * `Number.MAX_SAFE_INTEGER`, where distinct strings collapse to one value
 * (`…992` and `…993`), and a long enough run yields `Infinity - Infinity`, so
 * the comparator returns `NaN` and the sort order becomes undefined. Once
 * leading zeros are dropped, the longer run is the larger number and equal
 * lengths order lexically — which is the same ordering, computed exactly.
 */
function compareDigitRuns(left: string, right: string): number {
  const leftDigits = left.replace(LEADING_ZEROS_PATTERN, "");
  const rightDigits = right.replace(LEADING_ZEROS_PATTERN, "");
  if (leftDigits.length !== rightDigits.length) {
    return leftDigits.length - rightDigits.length;
  }
  if (leftDigits === rightDigits) {
    return 0;
  }
  return leftDigits < rightDigits ? -1 : 1;
}
