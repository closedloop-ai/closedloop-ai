"use client";

import { DocumentsIndexEmptyState } from "@repo/app/documents/components/documents-index-empty-state";
import { DocumentsIndexPaginationFooter } from "@repo/app/documents/components/documents-index-pagination";
import { DocumentsStaleRefreshNotice } from "@repo/app/documents/components/documents-stale-refresh-notice";
import type { DocumentsIndexBodyProps } from "@repo/app/documents/components/index/documents-index-body-props";
import { DocumentsView } from "@repo/app/documents/components/table/documents-view";
import {
  countMatchingDocuments,
  DOCUMENTS_INDEX_CATEGORY,
  DocumentsIndexState,
  hasActiveSearch,
  resolveDocumentsIndexState,
} from "@repo/app/documents/lib/documents-index-state";
import { useMemo } from "react";

/**
 * The Documents index body under ISS-8940 — the flag-ON arm.
 *
 * Every branch below is selected by ONE resolved state rather than by a stack
 * of overlapping booleans, which is what makes the states mutually exclusive
 * instead of merely usually-disjoint — including the stale-plus-no-match
 * intersection, which is resolved as its own state rather than composed here
 * from two (whitlockk review, cid 3955716628). Two of them are the states the previous
 * arm could not express at all: a failed refresh over usable rows (which it
 * showed as an ordinary populated table, silently), and a zero-row read while a
 * search is typed (which it handed to the table's "no matching artifacts" copy,
 * blaming a filter for an absence the filter did not cause).
 */
export function DocumentsIndexBodyV2({
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
  const matchCount = useMemo(
    () => countMatchingDocuments(documents, filterText),
    [documents, filterText]
  );
  const state = resolveDocumentsIndexState({
    isLoading,
    isFetching,
    isError,
    rowCount: documents.length,
    matchCount,
    hasSearch: hasActiveSearch(filterText),
    searchAppliedUpstream,
  });

  if (
    state === DocumentsIndexState.BlockingError ||
    state === DocumentsIndexState.FirstUseEmpty ||
    state === DocumentsIndexState.NoResults ||
    state === DocumentsIndexState.StaleNoResults
  ) {
    return <DocumentsIndexEmptyState onRetry={refetch} state={state} />;
  }

  return (
    <>
      {state === DocumentsIndexState.StaleAfterFailedRefresh && (
        <DocumentsStaleRefreshNotice onRetry={refetch} />
      )}
      {/* plain <div>, not <main>: the shell's SidebarInset owns the page's single main landmark (no-nested-main-landmark gate). */}
      <div className="flex-1 overflow-auto" ref={setScrollContainer}>
        <DocumentsView
          documents={documents}
          editHandlers={editHandlers}
          filterCategory={DOCUMENTS_INDEX_CATEGORY}
          filterText={filterText}
          hasUnpagedItems={hasUnpagedItems}
          // Never a row count while the read is open: the table renders its
          // skeleton, so an unsettled read cannot be read as "zero documents".
          isLoading={state === DocumentsIndexState.Loading}
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
