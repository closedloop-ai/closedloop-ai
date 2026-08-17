"use client";

// Experimental variant scoped to Generic Artifact pending explicit promotion review.

import {
  Pagination,
  PaginationContent,
  PaginationEllipsis,
  PaginationItem,
  PaginationLink,
  PaginationNext,
  PaginationPrevious,
} from "./pagination";

/**
 * Button-driven pagination control built on the shadcn `Pagination` primitives.
 * Renders Previous / numbered pages (with ellipses) / Next and calls
 * `onPageChange` with the target zero-based page. Data-agnostic and shared
 * across surfaces. The controls remain visible for a single page so the
 * disabled boundary states are predictable and the footer does not shift as
 * result counts change.
 */
export function TablePagination({
  page,
  totalPages,
  onPageChange,
  className,
}: {
  /** Zero-based current page index. */
  page: number;
  totalPages: number;
  onPageChange: (page: number) => void;
  className?: string;
}) {
  const safeTotalPages = Math.max(1, totalPages);
  const safePage = Math.min(Math.max(0, page), safeTotalPages - 1);
  const canPrev = safePage > 0;
  const canNext = safePage < safeTotalPages - 1;

  return (
    <Pagination className={className}>
      <PaginationContent>
        <PaginationItem>
          <PaginationPrevious
            aria-disabled={!canPrev}
            className={
              canPrev ? "cursor-pointer" : "pointer-events-none opacity-50"
            }
            onClick={() => {
              if (canPrev) {
                onPageChange(page - 1);
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
                className="cursor-pointer"
                isActive={token === safePage}
                onClick={() => onPageChange(token)}
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
            onClick={() => {
              if (canNext) {
                onPageChange(page + 1);
              }
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
