"use client";

import { type CountNoun, pluralize } from "@closedloop-ai/design-system/lib/count-noun";
import { cn } from "@closedloop-ai/design-system/lib/utils";
import type { ReactNode } from "react";
import { Chip } from "./chip";
import { GridEmptyValue } from "./grid-table-card";
import { Skeleton } from "./skeleton";
import type { SortDirection } from "./sortable-column-header";

/**
 * The shared "icon + number" table cell — comments, linked sessions,
 * invocations, versions.
 *
 * A count has three states and this cell keeps them apart:
 *
 * | State | Input | Rendered |
 * |---|---|---|
 * | still arriving | `loading` | a chip-sized `Skeleton`, read as "Loading {noun}" |
 * | genuinely none | `0` | the shared em-dash, read as "No {noun}" |
 * | not known | `null`/`undefined`/anything but a non-negative safe integer | the shared em-dash, read as "{noun} unavailable" |
 *
 * `loading` wins over any count, including a stale one still on the props from
 * a previous fetch — a number painted through that window is a lie about the
 * data, and a premature `0` is the same lie. A cardinality is a non-negative
 * integer: a negative, fractional, non-finite, or past-`MAX_SAFE_INTEGER` value
 * cannot be one, so it degrades to *unknown* rather than rendering and sorting
 * as a confident real count. `1.5 comments` is not a smaller lie than `-3`, and
 * beyond `Number.MAX_SAFE_INTEGER` distinct counts collapse onto one value.
 * This is browser code, where the repo bans debug logging, so a bad value
 * surfaces as the honest "unavailable" state rather than a fabricated number.
 * Zero and unknown share the em-dash glyph and never share their spoken text.
 *
 * Zero renders as that em-dash, which is what Branches did and the agents table
 * (a real `0`) did not. ISS-6384 settled which one is the house rule — "copy
 * that rule", meaning Branches' — so the agents catalog moves to the dash when
 * `artifact-cell-primitives` is on, and the two tables stop disagreeing about
 * what a zero looks like. It is the only user-perceivable change in that
 * migration, which is why the flag exists and defaults off.
 *
 * Every state's text lives in the DOM as an `sr-only` sibling, not an
 * `aria-label`: the non-interactive states are spans, where `aria-label` is
 * prohibited on the generic role and simply dropped. The interactive branches
 * ARE named with `aria-label`, valid on a button and a link. Loading is
 * deliberately NOT a live region — a 25-row table with two count columns would
 * mount 50 `role="status"` regions that all announce at once; the table's
 * loading container owns that.
 *
 * Non-interactive unless the caller supplies `onSelect` (button) or
 * `renderLink` (the caller's own navigation element — a raw `<a>` is a dead
 * click in the Electron renderer). `renderLink` wins if both are given, and
 * neither is offered for a zero or unknown count: a link into an empty list is
 * a dead end. A plain count wears no `Chip`; the chip is the affordance on the
 * interactive branches, not decoration.
 *
 * Sort with `compareCountValues`, filter with the existing `RangeSubmenu`, and
 * do not add inline editing — a count is derived from a relation, not typed
 * (`InlineScalarCell` is the primitive for a user-entered number).
 *
 * `isEmptyCellValue` identifies an empty cell by element TYPE, so it cannot see
 * a sentinel produced *inside* a component — a `renderCell` returning
 * `<CountCell count={0} />` reads as populated and `GridTableCard` stacks a
 * blank "Comments —" row. Use `isCountCellEmpty` at the call site and return
 * `GridEmptyValue` yourself, as `MetricCell` and `SessionCostCell` already do.
 */
export function CountCell({
  count,
  noun,
  icon,
  loading = false,
  alignEnd = false,
  size,
  onSelect,
  renderLink,
  className,
}: Readonly<CountCellProps>) {
  const alignClass = alignEnd ? "ml-auto" : undefined;
  const { state, value: resolved } = resolveCountCellState(count, loading);

  if (state === CountCellState.Loading) {
    return (
      <span className={cn("inline-flex items-center", alignClass, className)}>
        {/* Sized to the chip box it stands in for, but left as the product's
            one skeleton treatment — a chip's border and fill on a pulsing
            block reads as an empty chip, not as a value on its way. */}
        <Skeleton aria-hidden className="h-6 w-12 rounded-full" />
        <span className="sr-only">{`Loading ${pluralize(noun, 0)}`}</span>
      </span>
    );
  }

  if (state === CountCellState.Unknown) {
    return (
      <EmptyCount
        className={cn(alignClass, className)}
        text={`${pluralize(noun, 0)} unavailable`}
      />
    );
  }
  if (state === CountCellState.Zero) {
    return (
      <EmptyCount
        className={cn(alignClass, className)}
        text={`No ${pluralize(noun, 0)}`}
      />
    );
  }

  const formatted = COUNT_FORMAT.format(resolved);
  const accessibleName = `${formatted} ${pluralize(noun, resolved)}`;
  const content = (
    <>
      {icon}
      <span className="tabular-nums">{formatted}</span>
    </>
  );

  if (renderLink || onSelect) {
    return (
      <InteractiveCount
        accessibleName={accessibleName}
        className={cn("gap-1", alignClass, className)}
        content={content}
        onSelect={onSelect}
        renderLink={renderLink}
        size={size}
      />
    );
  }
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 text-muted-foreground text-sm",
        alignClass,
        className
      )}
    >
      {icon}
      <span aria-hidden className="tabular-nums">
        {formatted}
      </span>
      <span className="sr-only">{accessibleName}</span>
    </span>
  );
}

/**
 * True when `CountCell` would render the shared empty value — a genuine zero or
 * an unknown count. Call this from a `renderCell` and return `GridEmptyValue`
 * directly when it holds, so the narrow-surface card can drop the row (see the
 * component docstring).
 *
 * **Pass the same `loading` you pass the cell.** `loading` wins over any count
 * in the renderer, so a still-arriving column is NOT empty — it owes the reader
 * a skeleton. A helper blind to `loading` reports a stale `0`/`null` as empty,
 * the card drops the row, and the skeleton the cell would have rendered never
 * reaches the narrow surface at all. Both this predicate and the component read
 * `resolveCountCellState`, so the two cannot answer differently.
 */
export function isCountCellEmpty(
  count: number | null | undefined,
  loading = false
): boolean {
  const { state } = resolveCountCellState(count, loading);
  return state === CountCellState.Zero || state === CountCellState.Unknown;
}

/**
 * Comparator for `CountCell` values. Unknown counts (`null`, `undefined`, and
 * anything that is not a non-negative safe integer) sort after every known
 * count in BOTH directions — a descending sort must not float "we don't know"
 * above the largest real number.
 *
 * That fixed placement is why this takes `direction` and returns an already
 * directed result. Wire it into a table through `SortConfig.directedComparator`
 * (`packages/app/shared/lib/table-utils.ts`), which passes the direction and
 * uses the result verbatim. Wiring it as a plain `comparator` instead is a bug:
 * that branch negates the whole result for a descending sort, which flips the
 * unknowns to the top — the same negation the built-in nulls-last path in
 * `compareSortValues` deliberately returns before reaching.
 */
export function compareCountValues(
  a: number | null | undefined,
  b: number | null | undefined,
  direction: SortDirection = "asc"
): number {
  const left = resolveCount(a);
  const right = resolveCount(b);
  if (left === null && right === null) {
    return 0;
  }
  if (left === null) {
    return 1;
  }
  if (right === null) {
    return -1;
  }
  const ascending = left - right;
  return direction === "desc" ? -ascending : ascending;
}


export type CountCellProps = {
  /**
   * The count. `null`/`undefined` means "not known" — pass `0` only when zero
   * is the real answer. Anything that is not a non-negative safe integer
   * (negative, fractional, non-finite, past `MAX_SAFE_INTEGER`) is treated as
   * unknown, because none of those can be a cardinality.
   */
  count: number | null | undefined;
  noun: CountNoun;
  /** Leading glyph. Decorative — mark it `aria-hidden`; `noun` carries meaning. */
  icon?: ReactNode;
  /** True while the count is still in flight. Renders a skeleton, never a number. */
  loading?: boolean;
  /** Push the cell to the end of its track, under a right-aligned column. */
  alignEnd?: boolean;
  /** Chip scale, interactive branches only. `sm` matches the denser tables. */
  size?: "default" | "lg" | "sm";
  /** Makes the count a button. Ignored when `renderLink` is supplied. */
  onSelect?: () => void;
  /**
   * Wraps the count in the caller's navigation element. The accessible name is
   * applied to the wrapper by this component, and also passed in so a caller
   * that needs it for a `title` or an analytics label has it.
   */
  renderLink?: (content: ReactNode, accessibleName: string) => ReactNode;
  className?: string;
};

/** The chip-shaped branch: a real control, where the pill is the affordance. */
function InteractiveCount({
  accessibleName,
  className,
  content,
  onSelect,
  renderLink,
  size,
}: Readonly<{
  accessibleName: string;
  className: string;
  content: ReactNode;
  onSelect?: () => void;
  renderLink?: (content: ReactNode, accessibleName: string) => ReactNode;
  size?: "default" | "lg" | "sm";
}>) {
  return (
    <Chip
      aria-label={accessibleName}
      asChild
      className={className}
      interactive
      size={size}
      variant="muted"
    >
      {renderLink ? (
        renderLink(content, accessibleName)
      ) : (
        <button onClick={onSelect} type="button">
          {content}
        </button>
      )}
    </Chip>
  );
}

/**
 * The em-dash both empty states share, with the sr-only sentence that tells
 * them apart. `title` puts the same sentence on hover for sighted readers.
 */
function EmptyCount({
  className,
  text,
}: Readonly<{ className?: string; text: string }>) {
  return (
    <span className={cn("inline-flex items-center", className)}>
      <GridEmptyValue title={text} />
      <span className="sr-only">{text}</span>
    </span>
  );
}

/**
 * Grouped, so `12847` reads as `12,847` down a column rather than as a digit
 * run a reader has to count. The agents catalog already formatted its counts
 * this way, so the shared cell has to as well or adopting it would cost that
 * legibility. Locale-aware by construction: `undefined` takes the reader's own.
 */
const COUNT_FORMAT = new Intl.NumberFormat(undefined);

/**
 * `null` for every value that cannot be a real count. A cardinality is a
 * non-negative integer inside the safe range: `Number.isSafeInteger` is the one
 * boundary that rejects `NaN`, `±Infinity`, `1.5`, and `2 ** 53` alike, so a
 * fractional or overflowed value degrades to unknown here rather than reaching
 * the renderer and the comparator as a confident number.
 */
function resolveCount(count: number | null | undefined): number | null {
  if (count == null || !Number.isSafeInteger(count) || count < 0) {
    return null;
  }
  return count;
}

/** The branch `CountCell` takes. Named so the renderer cannot drift from
 * `isCountCellEmpty`, which has to answer for the same input. */
const CountCellState = {
  Loading: "loading",
  Unknown: "unknown",
  Zero: "zero",
  Count: "count",
} as const;
type CountCellState = (typeof CountCellState)[keyof typeof CountCellState];

/**
 * The single resolver behind both `CountCell` and `isCountCellEmpty`. `loading`
 * is checked first and wins outright, so a still-arriving column is never
 * classified by the stale count still sitting on its props.
 */
function resolveCountCellState(
  count: number | null | undefined,
  loading: boolean
): { state: CountCellState; value: number } {
  if (loading) {
    return { state: CountCellState.Loading, value: 0 };
  }
  const resolved = resolveCount(count);
  if (resolved === null) {
    return { state: CountCellState.Unknown, value: 0 };
  }
  if (resolved === 0) {
    return { state: CountCellState.Zero, value: 0 };
  }
  return { state: CountCellState.Count, value: resolved };
}
