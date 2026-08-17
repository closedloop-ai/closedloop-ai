"use client";

import type { DocumentColumn } from "@repo/app/shared/hooks/use-column-visibility";
import { ARTIFACT_COLUMN_LABELS } from "@repo/app/shared/hooks/use-column-visibility";
import { GridTableCard } from "@repo/design-system/components/ui/grid-table";
import { Skeleton } from "@repo/design-system/components/ui/skeleton";
import { useContainerWidth } from "@repo/design-system/hooks/use-container-width";
import { CARD_FALLBACK_BREAKPOINT } from "@repo/design-system/lib/column-order";
import { getDocumentRowGridTemplateColumns } from "./document-row";
import { DocumentTableHeader } from "./table-header";

type DocumentTableSkeletonProps = {
  visibleColumns: DocumentColumn[];
  /** Number of placeholder rows to render. */
  rowCount?: number;
  /**
   * Screen-reader label announcing what is loading. Defaults to a
   * caller-agnostic "Loading…" so this shared component (rendered by
   * `DocumentsView` for documents, features, and plans, not just My Tasks)
   * does not assert one caller's noun.
   */
  label?: string;
};

const DEFAULT_ROW_COUNT = 8;
const DEFAULT_LABEL = "Loading…";

// Below CARD_FALLBACK_BREAKPOINT the real rows fall back to stacked cards, so
// the skeleton mirrors that fallback instead of rendering a wide
// horizontally-scrolling grid that snaps to cards the moment data lands (the
// exact layout shift this treatment prevents). ISS-4788: reads the shared
// constant `DocumentRow` now reads too, rather than a third copy of the 768
// literal, so loading and content cannot split apart (wongk review).

/**
 * Loading treatment for the documents table. Renders the real
 * `DocumentTableHeader` (inert — no sort state, a no-op `onSort`) so the header
 * chrome never drifts from the live table and the fixed column labels are not
 * skeletonized as if they were data, plus `rowCount` skeleton rows. The rows
 * reuse the same grid template as the real rows
 * (`getDocumentRowGridTemplateColumns`) at wide widths and mirror the real card
 * fallback below 768px, so there is no layout shift when the data arrives and
 * the empty state never flashes while the list is still fetching. Shown by
 * `DocumentsView` when `isLoading` is true instead of the empty state
 * (FEA-3938).
 */
export function DocumentTableSkeleton({
  visibleColumns,
  rowCount = DEFAULT_ROW_COUNT,
  label = DEFAULT_LABEL,
}: DocumentTableSkeletonProps) {
  const { ref: containerRef, width: containerWidth } =
    useContainerWidth<HTMLDivElement>();
  const showCard = containerWidth < CARD_FALLBACK_BREAKPOINT;
  const rows = Array.from({ length: rowCount }, (_, index) => index);

  return (
    // Full-width observed wrapper so the ResizeObserver reports the real
    // available width rather than the grid's overflowed intrinsic width — the
    // same pattern the real `DocumentRow` uses to decide the card fallback.
    <div
      aria-busy="true"
      aria-live="polite"
      className="w-full"
      ref={containerRef}
    >
      <span className="sr-only">{label}</span>
      <DocumentTableHeader
        onSort={noopSort}
        sortBy={null}
        sortDir="asc"
        visibleColumns={visibleColumns}
      />
      {showCard ? (
        <DocumentTableSkeletonCards
          rows={rows}
          visibleColumns={visibleColumns}
        />
      ) : (
        <DocumentTableSkeletonGrid
          rows={rows}
          visibleColumns={visibleColumns}
        />
      )}
    </div>
  );
}

function DocumentTableSkeletonGrid({
  rows,
  visibleColumns,
}: {
  rows: number[];
  visibleColumns: DocumentColumn[];
}) {
  const gridTemplateColumns = getDocumentRowGridTemplateColumns(
    visibleColumns.length
  );
  return (
    <div className="min-w-fit">
      {rows.map((row) => (
        <div
          className="relative grid min-h-11 min-w-fit bg-background"
          key={row}
          style={{ gridTemplateColumns }}
        >
          <div className="pointer-events-none absolute inset-x-0 bottom-0 border-b" />
          <div className="flex min-h-11 items-center px-3 py-2">
            <Skeleton className="h-4 w-2/3" />
          </div>
          {visibleColumns.map((column) => (
            <div
              className="flex min-h-11 items-center border-l px-3 py-2"
              key={column}
            >
              <Skeleton className="h-4 w-16" />
            </div>
          ))}
          <div className="flex min-h-11 items-center border-l px-1 py-2" />
        </div>
      ))}
    </div>
  );
}

function DocumentTableSkeletonCards({
  rows,
  visibleColumns,
}: {
  rows: number[];
  visibleColumns: DocumentColumn[];
}) {
  return (
    <div className="flex flex-col gap-3 p-4">
      {rows.map((row) => (
        <GridTableCard
          fields={visibleColumns.map((column) => ({
            key: column,
            label: ARTIFACT_COLUMN_LABELS[column],
            value: <Skeleton className="h-4 w-16" />,
          }))}
          header={<Skeleton className="h-4 w-2/3" />}
          key={row}
        />
      ))}
    </div>
  );
}

function noopSort() {
  // Inert header: the skeleton is not interactive, so sorting is a no-op.
}
