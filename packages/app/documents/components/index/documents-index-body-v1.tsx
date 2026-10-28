"use client";

import { DocumentsIndexEmptyState } from "@repo/app/documents/components/documents-index-empty-state";
import { DocumentsIndexPaginationFooter } from "@repo/app/documents/components/documents-index-pagination";
import type { DocumentsIndexBodyProps } from "@repo/app/documents/components/index/documents-index-body-props";
import { DocumentsView } from "@repo/app/documents/components/table/documents-view";
import {
  DOCUMENTS_INDEX_CATEGORY,
  DocumentsIndexState,
} from "@repo/app/documents/lib/documents-index-state";

/**
 * The Documents index body as it shipped before ISS-8940 — the flag-OFF arm.
 *
 * Lifted out of `documents-index-view.tsx` with its derivation unchanged, so the
 * container holds ONE flag read and one switch and each arm derives its own
 * states unconditionally. Nothing here consults the flag, so this arm cannot
 * drift toward the new behavior by accident; when the flag retires this file is
 * what gets deleted.
 *
 * It renders the SAME `DocumentsIndexEmptyState` the new arm does. The arms
 * differ in which states they can reach, never in what a state says — a copy
 * edit that landed on only one of two verbatim duplicates is the failure that
 * component was extracted to prevent.
 */
export function DocumentsIndexBodyV1({
  documents,
  isLoading,
  isFetching,
  isError,
  refetch,
  filterText,
  searchAppliedUpstream,
  editHandlers,
  onDelete,
  onReorderColumns,
  visibleColumns,
  setScrollContainer,
  sortPersistenceKey,
  storageKey,
  pagination,
  hasUnpagedItems,
}: Readonly<DocumentsIndexBodyProps>) {
  const hasAnyDocuments = documents.length > 0;
  const isListLoading = isLoading || (!hasAnyDocuments && isFetching);
  // Only block the whole surface when the read failed AND there are no cached
  // rows to show. TanStack Query keeps the last successful data through a failed
  // background refetch, so a transient refetch error must not replace a
  // populated table with a full error state — the usable rows stay rendered.
  const isBlockingError = isError && !hasAnyDocuments;
  const isSettledEmpty = !(isBlockingError || isListLoading || hasAnyDocuments);
  // ISS-9819: rows that arrived ALREADY SEARCHED cannot answer how many
  // documents exist, so a zero here means "none matched", never "none exist".
  // Falling through to `DocumentsView` reads that zero as an empty corpus —
  // `hasAnyItems` is a row count, and the term never reached it — and a
  // populated organization is told "No artifacts yet — Create a PRD, issue, or
  // plan." This is the same distinction ISS-9762 gave the flag-ON arm, reached
  // on the `documents-index-server-search`-ON / `documents-index-states`-OFF
  // permutation the two independent keys make real.
  const isNoResults = isSettledEmpty && searchAppliedUpstream;
  // Own the truly-empty state so the surface reads as a Documents index, not
  // the shared table's project-flavored "Create a PRD, issue, or plan" copy
  // (which would misdirect here). A no-match under a CLIENT-side search is
  // still left to DocumentsView, whose "No matching artifacts / adjust your
  // filter" copy is already right: there the rows are the population, so its
  // row count answers the question the server never was asked.
  const isEmpty = isSettledEmpty && filterText.trim() === "";

  if (isBlockingError) {
    return (
      <DocumentsIndexEmptyState
        onRetry={refetch}
        state={DocumentsIndexState.BlockingError}
      />
    );
  }

  // Checked BEFORE the empty-corpus branch, which is what makes the two
  // mutually exclusive here rather than by appeal to the container's debounce
  // timing: a term held in the box while the debounced one has already been
  // answered satisfies both predicates, and only one of them is true.
  if (isNoResults) {
    return (
      <DocumentsIndexEmptyState
        onRetry={refetch}
        state={DocumentsIndexState.NoResults}
      />
    );
  }

  if (isEmpty) {
    return (
      <DocumentsIndexEmptyState
        onRetry={refetch}
        state={DocumentsIndexState.FirstUseEmpty}
      />
    );
  }

  return (
    <>
      {/* plain <div>, not <main>: the shell's SidebarInset owns the page's single main landmark (no-nested-main-landmark gate). */}
      <div className="flex-1 overflow-auto" ref={setScrollContainer}>
        <DocumentsView
          documents={documents}
          editHandlers={editHandlers}
          filterCategory={DOCUMENTS_INDEX_CATEGORY}
          filterText={filterText}
          hasUnpagedItems={hasUnpagedItems}
          isLoading={isListLoading}
          loadingLabel="Loading documents…"
          onDelete={onDelete}
          onReorderColumns={onReorderColumns}
          sortPersistenceKey={sortPersistenceKey}
          storageKey={storageKey}
          treeData={null}
          visibleColumns={visibleColumns}
        />
      </div>
      {pagination && <DocumentsIndexPaginationFooter pagination={pagination} />}
    </>
  );
}
