"use client";

import {
  DOCUMENT_LIST_MAX_SEARCH_LENGTH,
  DocumentType,
  type DocumentWithProject,
  type FindDocumentsOptions,
} from "@repo/api/src/types/document";
import type { ArtifactListReadState } from "@repo/app/artifacts/components/artifact-list";
import type { DocumentsIndexPagination } from "@repo/app/documents/components/documents-index-pagination";
import {
  useDocuments,
  useDocumentsPage,
} from "@repo/app/documents/hooks/use-documents";
import {
  useDocumentsIndexPageClamp,
  useDocumentsIndexPaging,
} from "@repo/app/documents/hooks/use-documents-index-paging";
import {
  buildDocumentsIndexPagination,
  buildDocumentsIndexPlaceholder,
  DOCUMENTS_INDEX_SEARCH_DEBOUNCE_MS,
  readDocumentsIndexEnvelope,
} from "@repo/app/documents/lib/documents-index-paged-read";
import { useDebouncedValue } from "@repo/app/shared/hooks/use-debounced-value";
import { useMemo } from "react";

export type IssuesIndexRead = {
  documents: DocumentWithProject[];
  isLoading: boolean;
  isFetching: boolean;
  isError: boolean;
  refetch: () => unknown;
  isServerPaged: boolean;
  isSummaryUnsettled: boolean;
  searchAppliedUpstream: boolean;
  /** The cohort the summary and cost reads scope by, never an ID list. */
  summaryParams: FindDocumentsOptions;
  pagination: DocumentsIndexPagination | undefined;
};

/**
 * The org-wide Issues read: one server page at a time, through the paging the
 * Documents index uses (ISS-9157). A term the endpoint refuses (over
 * `DOCUMENT_LIST_MAX_SEARCH_LENGTH`) cannot be answered by a server page, so
 * that term alone falls back to the unpaged read narrowed by the client filter,
 * as the Documents index does. While `ArtifactList` reports its complete read
 * (a sort, grouping or filter needs every row), it reads the population itself
 * and the page read here is held.
 */
export function useIssuesIndexRead({
  filterText,
  listRead,
  pageSizeStorageKey,
  recencyDays,
  scrollContainer,
}: {
  filterText: string;
  /** What `ArtifactList` last reported; `undefined` before its first render. */
  listRead: ArtifactListReadState | undefined;
  pageSizeStorageKey: string | null;
  recencyDays: number | undefined;
  scrollContainer: HTMLElement | null;
}): IssuesIndexRead {
  const debouncedFilterText = useDebouncedValue(
    filterText,
    DOCUMENTS_INDEX_SEARCH_DEBOUNCE_MS
  );
  const trimmedTerm = debouncedFilterText.trim();
  const isPagedArm = trimmedTerm.length <= DOCUMENT_LIST_MAX_SEARCH_LENGTH;
  const search = isPagedArm && trimmedTerm !== "" ? trimmedTerm : undefined;
  const cohortParams = useMemo<FindDocumentsOptions>(
    () => ({
      types: [DocumentType.Feature],
      ...(search === undefined ? {} : { search }),
      ...(recencyDays === undefined ? {} : { recencyDays }),
    }),
    [search, recencyDays]
  );
  const unboundedParams = useMemo<FindDocumentsOptions>(
    () => ({
      types: [DocumentType.Feature],
      ...(recencyDays === undefined ? {} : { recencyDays }),
    }),
    [recencyDays]
  );
  const unbounded = useDocuments(unboundedParams, { enabled: !isPagedArm });

  // The cursor resets on the order ArtifactList actually renders, so the two
  // cannot disagree about which sort is in force.
  const paging = useDocumentsIndexPaging({
    identity: {
      pageSizeStorageKey,
      search,
      sortBy: listRead?.sortBy ?? null,
      sortDir: listRead?.sortDir ?? "asc",
      recencyDays,
    },
    scrollContainer,
  });
  const pagedParams = useMemo(
    () => ({ ...cohortParams, limit: paging.pageSize, offset: paging.offset }),
    [cohortParams, paging.pageSize, paging.offset]
  );
  const placeholderData = useMemo(
    () =>
      buildDocumentsIndexPlaceholder({
        pageSize: paging.pageSize,
        search,
        recencyDays,
      }),
    [paging.pageSize, search, recencyDays]
  );
  const isPagedReadEnabled =
    isPagedArm && paging.isPageSizeReady && listRead?.completeRead !== true;
  const paged = useDocumentsPage(pagedParams, {
    enabled: isPagedReadEnabled,
    placeholderData,
  });
  const envelopeRead = readDocumentsIndexEnvelope({
    envelope: paged.data,
    isPlaceholderData: paged.isPlaceholderData,
    requestedPage: paging.page,
    requestedPageSize: paging.pageSize,
  });
  useDocumentsIndexPageClamp({
    enabled: isPagedReadEnabled,
    hasData: envelopeRead.hasSettledEnvelope,
    isFetching: paged.isFetching,
    page: paging.page,
    pageSize: envelopeRead.effectivePageSize,
    setPage: paging.setPage,
    total: envelopeRead.total,
  });

  const isSearchTermSettling = isPagedArm && debouncedFilterText !== filterText;
  const isReadUndecided = isPagedArm && !paging.isPageSizeReady;
  const isHeld =
    isSearchTermSettling || isReadUndecided || envelopeRead.isOutOfRange;
  const pagination =
    isPagedArm && paged.data !== undefined
      ? buildDocumentsIndexPagination({
          envelopeRead,
          isPagerUnsettled: paged.isPlaceholderData || isHeld,
          paging,
          noun: ISSUES_INDEX_READOUT_NOUN,
        })
      : undefined;
  const read = isPagedArm
    ? {
        documents: envelopeRead.pagedItems,
        isLoading: paged.isLoading,
        isFetching: paged.isFetching,
        isError: paged.isError,
        refetch: paged.refetch,
      }
    : {
        documents: unbounded.data ?? NO_ISSUES,
        isLoading: unbounded.isLoading,
        isFetching: unbounded.isFetching,
        isError: unbounded.isError,
        refetch: unbounded.refetch,
      };
  return {
    ...read,
    isLoading: read.isLoading || isHeld,
    isFetching: read.isFetching || isHeld,
    isServerPaged: isPagedArm,
    isSummaryUnsettled:
      debouncedFilterText !== filterText || isReadUndecided || read.isLoading,
    searchAppliedUpstream: search !== undefined,
    summaryParams: isPagedArm ? cohortParams : unboundedParams,
    pagination,
  };
}

/** The plural `ArtifactList` already uses for the Issue kind's own states. */
const ISSUES_INDEX_READOUT_NOUN = "issues";
const NO_ISSUES: DocumentWithProject[] = [];
