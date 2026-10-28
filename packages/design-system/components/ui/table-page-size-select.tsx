"use client";

import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "./select";

/**
 * Rows-per-page control for a paginated table footer (FEA-4199).
 *
 * Lives in the design system beside `TablePaginationFooter` rather than in the
 * Sessions surface that asked for it, because every list surface already shares
 * that footer — a Sessions-local pager would be the fifth hand-rolled variant of
 * a strip that was consolidated precisely to stop those drifting apart.
 *
 * The label is rendered as the option text ("25 / page") rather than a separate
 * "Rows per page" caption: the footer strip is dense, and the accessible name
 * on the trigger already states the control's purpose for assistive tech.
 */

/**
 * The shared page-size ladder. Exported so a caller states the same three
 * choices everywhere instead of re-declaring the array (and so a test asserts
 * against one list). 25 leads because it is the size every surface shipped as
 * its fixed page size, so an existing user's first render is unchanged.
 */
export const TABLE_PAGE_SIZE_OPTIONS = [25, 50, 100] as const;

/**
 * ISS-9692: the ladder with the two large rungs added, offered behind the
 * `table-page-size-ladder` flag (default off).
 *
 * DERIVED from the base above rather than typed out again, so the two can never
 * disagree about the rungs they share — the whole shape of this ticket was a
 * shared ladder and a set of caps that had drifted apart.
 *
 * The server side of the same contract is `TABLE_PAGE_SIZE_MAX` in
 * `@repo/api/src/types/table-page-size-limits`. It is a SEPARATE declaration
 * because this package is gated from importing `@repo/api` (and `@repo/api`
 * cannot import a React package back); the agreement test named in that
 * module's docstring is what keeps the largest rung here at or below every list
 * endpoint's cap.
 */
export const TABLE_PAGE_SIZE_OPTIONS_EXTENDED = [
  ...TABLE_PAGE_SIZE_OPTIONS,
  250,
  500,
] as const;

/** The page size a surface uses before the user picks one. */
export const DEFAULT_TABLE_PAGE_SIZE = 25;

export function TablePageSizeSelect({
  pageSize,
  onPageSizeChange,
  options = TABLE_PAGE_SIZE_OPTIONS,
  disabled = false,
}: {
  pageSize: number;
  onPageSizeChange: (pageSize: number) => void;
  options?: readonly number[];
  disabled?: boolean;
}) {
  return (
    <Select
      disabled={disabled}
      onValueChange={(value) => {
        if (disabled) {
          return;
        }
        onPageSizeChange(Number.parseInt(value, 10));
      }}
      value={String(pageSize)}
    >
      <SelectTrigger
        // The visible text is just "25 / page", which does not say what the
        // control DOES. Naming it here is what makes it operable from a screen
        // reader's control list (WCAG 4.1.2 Name, Role, Value).
        aria-label="Rows per page"
        className="h-8 w-auto gap-1 text-xs"
        disabled={disabled}
        size="sm"
      >
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {options.map((option) => (
          <SelectItem key={option} value={String(option)}>
            {option} / page
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

/**
 * ISS-9692: the offered page size closest to `pageSize`, for a value that is no
 * longer legal.
 *
 * A persisted 500 has to survive two things it cannot control: a cap the server
 * later lowers, and the `table-page-size-ladder` flag going back off. Sending it
 * anyway is an invalid `limit` (a 400 on Sessions, a rejected response shape on
 * Branches), and silently resetting to the default throws away the intent — a
 * reader who asked for "as many as possible" gets the nearest thing the surface
 * can still serve, which is the largest legal rung.
 *
 * Ties break DOWN (`<` rather than `<=` on the distance), so a value exactly
 * between two rungs resolves to the smaller — never to a page heavier than the
 * one the reader last saw honored.
 *
 * Returns the first option for a non-finite/non-positive input; `options` is
 * assumed non-empty, which every ladder in this file is.
 */
export function resolveLegalTablePageSize(
  pageSize: number,
  options: readonly number[]
): number {
  const [first, ...rest] = options;
  if (!(Number.isFinite(pageSize) && pageSize > 0)) {
    return first;
  }
  let best = first;
  for (const option of rest) {
    if (Math.abs(option - pageSize) < Math.abs(best - pageSize)) {
      best = option;
    }
  }
  return best;
}

/**
 * The "1–25 of 240 sessions" range readout that sits beside the page-size
 * select. Derived here — from the page index, page size and total — so a
 * surface cannot state a range that disagrees with the page it actually
 * requested, which is the failure mode the shared footer exists to prevent.
 *
 * Returns `null` when there is nothing honest to say (no total, or an empty
 * result set), so a caller renders no readout rather than "1–0 of 0".
 */
export function buildTableRangeReadout({
  page,
  pageSize,
  total,
  noun,
  isTotalPartial = false,
  range,
}: {
  page: number;
  pageSize: number;
  total: number;
  /** Plural noun for the rows ("sessions", "branches"). */
  noun: string;
  /**
   * True when `total` counts only what the client actually holds because the
   * server bounded the read. The total is then rendered as a FLOOR ("500+"),
   * because "of 500" under a bounded read asserts a population size nobody
   * measured. Pair it with the footer's `truncationNote`: My Tasks learned
   * (`resolveMyTasksTruncation`) that a marker with no note is cryptic and a
   * note with no marker leaves a confident wrong number on screen.
   */
  isTotalPartial?: boolean;
  /**
   * The 1-based row range this page actually holds, for a surface whose pages
   * are NOT a fixed `pageSize` stride (ISS-4704: a grouped list packs whole
   * sections, so a page can hold 38 rows and the next 61). Without it the range
   * is derived from `page * pageSize`, which on such a surface names rows the
   * page does not contain. Omit on a fixed-stride surface — the derivation is
   * the same number and one fewer thing for a caller to get wrong.
   */
  range?: { from: number; to: number };
}): string | null {
  if (total <= 0) {
    return null;
  }
  // Clamp so an out-of-range page index (a stale `?page=` in the URL, a page
  // size the user just grew) can never render a range past the total.
  const firstIndex = Math.min(page * pageSize, Math.max(0, total - 1));
  const first = range ? range.from : firstIndex + 1;
  const last = range
    ? Math.min(range.to, total)
    : Math.min(firstIndex + pageSize, total);
  // All three numbers go through the SAME formatter. Localizing only the total
  // produced "1026–1050 of 12,550" — one readout in two number systems.
  const totalText = `${total.toLocaleString()}${isTotalPartial ? "+" : ""}`;
  return `${first.toLocaleString()}–${last.toLocaleString()} of ${totalText} ${noun}`;
}
