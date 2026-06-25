"use client";

import {
  Pagination,
  PaginationContent,
  PaginationEllipsis,
  PaginationItem,
  PaginationLink,
  PaginationNext,
  PaginationPrevious,
} from "@repo/design-system/components/ui/pagination";

/**
 * Button-driven pagination control built on the shadcn `Pagination` primitives.
 * Renders Previous / numbered pages (with ellipses) / Next and calls
 * `onPageChange` with the target zero-based page. Data-agnostic and shared
 * across surfaces. Renders nothing when there is a single page.
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
  if (totalPages <= 1) {
    return null;
  }

  const canPrev = page > 0;
  const canNext = page < totalPages - 1;

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
        {pageWindow(page, totalPages).map((token) =>
          token === "gap-left" || token === "gap-right" ? (
            <PaginationItem key={token}>
              <PaginationEllipsis />
            </PaginationItem>
          ) : (
            <PaginationItem key={token}>
              <PaginationLink
                className="cursor-pointer"
                isActive={token === page}
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
