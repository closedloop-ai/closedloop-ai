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

/** The page size a surface uses before the user picks one. */
export const DEFAULT_TABLE_PAGE_SIZE = 25;

export function TablePageSizeSelect({
  pageSize,
  onPageSizeChange,
  options = TABLE_PAGE_SIZE_OPTIONS,
}: {
  pageSize: number;
  onPageSizeChange: (pageSize: number) => void;
  options?: readonly number[];
}) {
  return (
    <Select
      onValueChange={(value) => onPageSizeChange(Number.parseInt(value, 10))}
      value={String(pageSize)}
    >
      <SelectTrigger
        // The visible text is just "25 / page", which does not say what the
        // control DOES. Naming it here is what makes it operable from a screen
        // reader's control list (WCAG 4.1.2 Name, Role, Value).
        aria-label="Rows per page"
        className="h-8 w-auto gap-1 text-xs"
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
}): string | null {
  if (total <= 0) {
    return null;
  }
  // Clamp so an out-of-range page index (a stale `?page=` in the URL, a page
  // size the user just grew) can never render a range past the total.
  const firstIndex = Math.min(page * pageSize, Math.max(0, total - 1));
  const first = firstIndex + 1;
  const last = Math.min(firstIndex + pageSize, total);
  // All three numbers go through the SAME formatter. Localizing only the total
  // produced "1026–1050 of 12,550" — one readout in two number systems.
  const totalText = `${total.toLocaleString()}${isTotalPartial ? "+" : ""}`;
  return `${first.toLocaleString()}–${last.toLocaleString()} of ${totalText} ${noun}`;
}
