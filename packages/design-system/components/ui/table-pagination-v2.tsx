"use client";

// Grid Table v2 promotion candidate, copied from the approved Generic Artifact prototype.

import { cn } from "@closedloop-ai/design-system/lib/utils";
import type { ReactNode } from "react";
import {
  Pagination,
  PaginationContent,
  PaginationEllipsis,
  PaginationItem,
  PaginationLink,
  PaginationNext,
  PaginationPrevious,
} from "./pagination";
import { TablePageSizeSelect } from "./table-page-size-select";

/**
 * Button-driven pagination control built on the shadcn `Pagination` primitives.
 * Renders Previous / numbered pages (with ellipses) / Next and calls
 * `onPageChange` with the target zero-based page. Data-agnostic and shared
 * across surfaces. The controls remain visible for a single page so the
 * disabled boundary states are predictable and the footer does not shift as
 * result counts change. `disabled` locks every control while keeping it
 * mounted, the same contract the v1 pager offers.
 */
export function TablePagination({
  page,
  totalPages,
  onPageChange,
  onPageSizeChange,
  pageSize,
  pageSizeOptions,
  readout,
  className,
  disabled = false,
}: {
  /** Zero-based current page index. */
  page: number;
  totalPages: number;
  onPageChange: (page: number) => void;
  /**
   * ISS-7052 Part A: rows-per-page, the same control and option list
   * `TablePaginationFooter` offers (FEA-4199). Supplied WITH `pageSize`, the
   * select renders; either alone renders nothing, because a select that cannot
   * report where it moved is a control that does not work.
   */
  onPageSizeChange?: (pageSize: number) => void;
  /** @see onPageSizeChange */
  pageSize?: number;
  /** @see onPageSizeChange */
  pageSizeOptions?: readonly number[];
  /**
   * ISS-7052 Part A: the range readout ("Showing 1-25 of 240"), announced as a
   * live region — paging here is button-driven and replaces the rows in place,
   * so without it a screen-reader user gets no confirmation that anything
   * moved. Omit when the surface has no total it can state honestly; an absent
   * readout is correct, a wrong one is not.
   */
  readout?: ReactNode;
  className?: string;
  /**
   * ISS-11412: locks every control (Previous, Next, each page and the
   * rows-per-page select) while keeping it mounted, so `TablePaginationFooter`
   * can hold paging while a placeholder page is on screen (ISS-9216). Each
   * control announces `aria-disabled` and reports no page. Defaults to false,
   * which renders exactly the markup the pager rendered before it existed.
   */
  disabled?: boolean;
}) {
  const { safePage, safeTotalPages, canPrev, canNext } = resolvePaginationBounds(
    page,
    totalPages
  );
  const showPageSize = pageSize !== undefined && onPageSizeChange !== undefined;

  if (readout || showPageSize) {
    return (
      <div
        className={cn(
          "flex flex-wrap items-center justify-between gap-3",
          className
        )}
      >
        <div className="flex items-center gap-3">
          {readout ? (
            // `role="status"`, matching `TablePaginationFooter` exactly: paging
            // here is button-driven with no route change, so without a live
            // region a screen-reader user gets no announcement that the page
            // changed. The two strips are deliberately identical — that
            // component's own docstring names drift between them as the hazard.
            <p
              className={cn(
                "text-muted-foreground",
                showPageSize ? "text-xs" : "text-sm"
              )}
              role="status"
            >
              {readout}
            </p>
          ) : null}
          {showPageSize ? (
            <TablePageSizeSelect
              disabled={disabled}
              onPageSizeChange={onPageSizeChange}
              options={pageSizeOptions}
              pageSize={pageSize}
            />
          ) : null}
        </div>
        <Pagination className="mx-0 w-auto justify-end">
          {paginationContent({
            canNext,
            canPrev,
            disabled,
            onPageChange,
            safePage,
            safeTotalPages,
          })}
        </Pagination>
      </div>
    );
  }

  return (
    <Pagination className={className}>
      {paginationContent({
        canNext,
        canPrev,
        disabled,
        onPageChange,
        safePage,
        safeTotalPages,
      })}
    </Pagination>
  );
}

/**
 * The Previous / numbered / Next controls, lifted so the plain and the
 * readout+page-size layouts render the SAME control set rather than two copies
 * that could drift.
 */
function paginationContent({
  canNext: boundsAllowNext,
  canPrev: boundsAllowPrev,
  disabled,
  onPageChange,
  safePage,
  safeTotalPages,
}: {
  canNext: boolean;
  canPrev: boolean;
  disabled: boolean;
  onPageChange: (page: number) => void;
  safePage: number;
  safeTotalPages: number;
}): ReactNode {
  const canPrev = !disabled && boundsAllowPrev;
  const canNext = !disabled && boundsAllowNext;
  return (
        <PaginationContent>
          <PaginationItem>
            <PaginationPrevious
              aria-disabled={!canPrev}
              className={
                canPrev ? "cursor-pointer" : "pointer-events-none opacity-50"
              }
              href="#"
              onClick={(event) => {
                event.preventDefault();
                if (canPrev) {
                  // `safePage`, never the raw `page`: an out-of-range `page`
                  // rendered clamped but emitted `page - 1`, so a caller that
                  // trusted the control got another out-of-range page back.
                  onPageChange(safePage - 1);
                }
              }}
            />
          </PaginationItem>
          {pageWindow(safePage, safeTotalPages).map((token) =>
            token === "gap-left" || token === "gap-right" ? (
              <PaginationItem key={token}>
                <PaginationEllipsis />
              </PaginationItem>
            ) : (
              <PaginationItem key={token}>
                <PaginationLink
                  aria-disabled={disabled || undefined}
                  className={
                    disabled
                      ? "pointer-events-none opacity-50"
                      : "cursor-pointer"
                  }
                  isActive={token === safePage}
                  href="#"
                  onClick={(event) => {
                    event.preventDefault();
                    if (!disabled) {
                      onPageChange(token);
                    }
                  }}
                >
                  {token + 1}
                </PaginationLink>
              </PaginationItem>
            )
          )}
          <PaginationItem>
            <PaginationNext
              aria-disabled={!canNext}
              className={
                canNext ? "cursor-pointer" : "pointer-events-none opacity-50"
              }
              href="#"
              onClick={(event) => {
                event.preventDefault();
                if (canNext) {
                  onPageChange(safePage + 1);
                }
              }}
            />
          </PaginationItem>
        </PaginationContent>
  );
}

type PageToken = number | "gap-left" | "gap-right";

export type PaginationBounds = {
  /** `page` coerced to a finite integer inside `[0, safeTotalPages - 1]`. */
  safePage: number;
  /** `totalPages` coerced to a finite integer of at least 1. */
  safeTotalPages: number;
  canPrev: boolean;
  canNext: boolean;
};

/**
 * whitlockk review: normalize the untrusted `page` / `totalPages` ONCE, to finite
 * integers, before anything reads them — the window, the disabled states, and
 * the page the Previous/Next callbacks emit all derive from the result.
 *
 * The naive `Math.max(1, totalPages)` / `Math.min(Math.max(0, page), …)` pair
 * this replaces let three classes of input through:
 *  - `NaN` propagates (`Math.max(1, NaN)` is `NaN`), so every comparison below
 *    is false and the control renders with no active page at all.
 *  - `Infinity` survives, and an infinite total makes {@link pageWindow}'s
 *    `p <= current + 1` loop never terminate, because `Infinity + 1` is still
 *    `Infinity` and `p++` cannot advance past it.
 *  - Fractions survive into `aria`/label arithmetic and emitted pages.
 *
 * Extracted from the component so the boundary behavior is unit-testable
 * without rendering a paginator.
 */
export function resolvePaginationBounds(
  page: number,
  totalPages: number
): PaginationBounds {
  const safeTotalPages = Math.max(1, toFiniteInteger(totalPages, 1));
  const safePage = clamp(toFiniteInteger(page, 0), 0, safeTotalPages - 1);
  return {
    safePage,
    safeTotalPages,
    canPrev: safePage > 0,
    canNext: safePage < safeTotalPages - 1,
  };
}

/**
 * Coerce an untrusted page/total to a finite integer, falling back to
 * `fallback` for `NaN` and `±Infinity`. `Math.trunc` (not `round`) so a
 * fractional page never rounds UP past the last page.
 */
function toFiniteInteger(value: number, fallback: number): number {
  return Number.isFinite(value) ? Math.trunc(value) : fallback;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

/**
 * Build the visible page tokens: always the first and last page, the current
 * page and its immediate neighbours, with a single ellipsis collapsing each
 * remaining gap. Pages are zero-based.
 */
function pageWindow(current: number, total: number): PageToken[] {
  const visible = new Set<number>([0, total - 1]);
  for (let p = current - 1; p <= current + 1; p++) {
    if (p >= 0 && p < total) {
      visible.add(p);
    }
  }
  const sorted = [...visible].sort((a, b) => a - b);

  const tokens: PageToken[] = [];
  for (let i = 0; i < sorted.length; i++) {
    const value = sorted[i] as number;
    const prev = sorted[i - 1];
    if (prev !== undefined && value - prev > 1) {
      tokens.push(value <= current ? "gap-left" : "gap-right");
    }
    tokens.push(value);
  }
  return tokens;
}
