"use client";

import {
  Pagination,
  PaginationContent,
  PaginationEllipsis,
  PaginationItem,
  PaginationLink,
  PaginationNext,
  PaginationPrevious,
} from "@closedloop-ai/design-system/components/ui/pagination";

/**
 * Button-driven pagination control built on the shadcn `Pagination` primitives.
 * Renders Previous / numbered pages (with ellipses) / Next and calls
 * `onPageChange` with the target zero-based page. Data-agnostic and shared
 * across surfaces. Renders nothing when there is a single page, unless
 * `showOnSinglePage` asks it to stay. Out-of-range `page` / `totalPages`
 * inputs are clamped rather than rendered, so a stale page index from a
 * narrowing filter cannot produce a page number the data cannot back.
 */
export function TablePagination({
  page,
  totalPages,
  onPageChange,
  className,
  showOnSinglePage = false,
  disabled = false,
}: {
  /** Zero-based current page index. */
  page: number;
  totalPages: number;
  onPageChange: (page: number) => void;
  className?: string;
  disabled?: boolean;
  /**
   * Keeps the control mounted (with both boundaries disabled) when there is only
   * one page, so a footer does not gain and lose a row as a filter narrows the
   * result set. Opt-in: the surfaces that shipped the collapsing footer keep it.
   */
  showOnSinglePage?: boolean;
}) {
  // `totalPages < 1` is unconditional: `showOnSinglePage` asks for a ONE-page
  // control, and there is no honest page number to render for zero pages.
  if (totalPages < 1 || (totalPages === 1 && !showOnSinglePage)) {
    return null;
  }

  const safeTotalPages = Math.max(1, totalPages);
  const safePage = Math.min(Math.max(0, page), safeTotalPages - 1);
  const canPrev = !disabled && safePage > 0;
  const canNext = !disabled && safePage < safeTotalPages - 1;

  return (
    <Pagination className={className}>
      <PaginationContent>
        <PaginationItem>
          <PaginationPrevious
            aria-disabled={!canPrev}
            className={
              canPrev ? "cursor-pointer" : "pointer-events-none opacity-50"
            }
            onClick={(event) => {
              if (!canPrev) {
                event.preventDefault();
                return;
              }
              onPageChange(safePage - 1);
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
                  disabled ? "pointer-events-none opacity-50" : "cursor-pointer"
                }
                isActive={token === safePage}
                onClick={(event) => {
                  if (disabled) {
                    event.preventDefault();
                    return;
                  }
                  onPageChange(token);
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
            onClick={(event) => {
              if (!canNext) {
                event.preventDefault();
                return;
              }
              onPageChange(safePage + 1);
            }}
          />
        </PaginationItem>
      </PaginationContent>
    </Pagination>
  );
}

type PageToken = number | "gap-left" | "gap-right";

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
