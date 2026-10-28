"use client";

import { ArtifactStatusEditSurface } from "@repo/api/src/types/artifact-status-contract";
import type { Priority } from "@repo/api/src/types/common";
import {
  DOCUMENT_LIST_MAX_SEARCH_LENGTH,
  DocumentType,
} from "@repo/api/src/types/document";
import { ArtifactList } from "@repo/app/artifacts/components/artifact-list";
import { DocumentsIndexPaginationFooter } from "@repo/app/documents/components/documents-index-pagination";
import { useDocumentsCreateAction } from "@repo/app/documents/components/index/documents-create-action";
import {
  DOCUMENTS_INDEX_PAGE_SIZE_KEY,
  DOCUMENTS_INDEX_SCROLL_KEY,
  DOCUMENTS_INDEX_SEARCH_KEY,
  DOCUMENTS_INDEX_SORT_KEY,
  DOCUMENTS_INDEX_STORAGE_KEY,
} from "@repo/app/documents/components/index/documents-index-keys";
import { DocumentsPrototypeBulkActions } from "@repo/app/documents/components/index/documents-prototype-bulk-actions";
import type { RowEditHandlers } from "@repo/app/documents/components/table/row-edit-context";
import {
  SORT_KEYS,
  SortKey,
} from "@repo/app/documents/components/table/sort-keys";
import {
  useDocuments,
  useDocumentsPage,
  useUpdateDocument,
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
import { DEFAULT_ARTIFACT_DATE_RANGE } from "@repo/app/shared/components/generic-artifact-surface/preview/components/artifact-date-dimension";
import { useFeatureFlagGate } from "@repo/app/shared/feature-flags/use-feature-flag-enabled";
import { useDebouncedValue } from "@repo/app/shared/hooks/use-debounced-value";
import { useScrollRestore } from "@repo/app/shared/hooks/use-scroll-restore";
import { useSortParams } from "@repo/app/shared/hooks/use-sort-params";
import { useViewStateKey } from "@repo/app/shared/hooks/use-view-state-key";
import { useViewStatePersistence } from "@repo/app/shared/hooks/use-view-state-persistence";
import {
  DOCUMENTS_INDEX_PAGED_FEATURE_FLAG_KEY,
  DOCUMENTS_INDEX_SERVER_SEARCH_FEATURE_FLAG_KEY,
} from "@repo/app/shared/lib/feature-flags";
import { useOrgUsersAsPopoverUsers } from "@repo/app/users/hooks/use-org-users-as-popover-users";
import { useMemo, useState } from "react";

export function DocumentsUniversalIndexView() {
  const onRequestCreate = useDocumentsCreateAction();
  const [recencyDays, setRecencyDays] = useState<number | undefined>(() =>
    Number(DEFAULT_ARTIFACT_DATE_RANGE.slice(0, -1))
  );
  // The GATE, not the bare flag: `useFeatureFlagEnabled` reads `false` until
  // PostHog answers, so keying the read off it alone would issue the unsearched
  // request for a reader whose search term was restored from a previous visit,
  // then supersede it the moment the flag flipped — the FEA-1626 cost this
  // helper's own docstring names.
  const { enabled: serverSearchEnabled, isReady: serverSearchReady } =
    useFeatureFlagGate(DOCUMENTS_INDEX_SERVER_SEARCH_FEATURE_FLAG_KEY);
  // Same posture for the paged read (ISS-9157): which of the two reads goes out
  // depends on this answer, so neither goes out until it has landed. Off is the
  // shipped unbounded read, byte for byte.
  const { enabled: pagedEnabled, isReady: pagedReady } = useFeatureFlagGate(
    DOCUMENTS_INDEX_PAGED_FEATURE_FLAG_KEY
  );
  // ISS-9726: every persisted key on this surface is namespaced by the active
  // organization, so entering a different one starts from defaults instead of
  // inheriting a search term that silently narrows its documents.
  const searchKey = useViewStateKey(DOCUMENTS_INDEX_SEARCH_KEY);
  const scrollKey = useViewStateKey(DOCUMENTS_INDEX_SCROLL_KEY);
  const sortKey = useViewStateKey(DOCUMENTS_INDEX_SORT_KEY);
  const expansionStorageKey = useViewStateKey(DOCUMENTS_INDEX_STORAGE_KEY);
  const pageSizeKey = useViewStateKey(DOCUMENTS_INDEX_PAGE_SIZE_KEY);
  const [filterText, setFilterText] = useViewStatePersistence<string>(
    searchKey,
    ""
  );
  const [scrollContainer, setScrollContainer] = useState<HTMLElement | null>(
    null
  );
  useScrollRestore(scrollKey, scrollContainer);

  // ISS-9724: settle the term before it becomes a query key, so a typed word is
  // one request rather than one per keystroke.
  const debouncedFilterText = useDebouncedValue(
    filterText,
    DOCUMENTS_INDEX_SEARCH_DEBOUNCE_MS
  );
  // Waiting on the gate matters ONLY while a term is in the box: with no term
  // the request is byte-identical under either flag value, so holding it back
  // would delay every reader's first paint to decide something that cannot
  // change the read.
  const hasTypedTerm = filterText.trim() !== "";

  // Which read this render issues (ISS-9157). A term the endpoint refuses
  // (over `DOCUMENT_LIST_MAX_SEARCH_LENGTH`) cannot be answered by a server
  // page at all — titles are unbounded, so it can still match — and the only
  // read that answers it honestly is the shipped one: the whole population,
  // narrowed by the client filter, with no pager.
  const isTermOverLong =
    debouncedFilterText.trim().length > DOCUMENT_LIST_MAX_SEARCH_LENGTH;
  const isPagedArm = pagedReady && pagedEnabled && !isTermOverLong;
  const isUnboundedArm = pagedReady && !isPagedArm;
  const serverSearchUndecided =
    isUnboundedArm && !serverSearchReady && hasTypedTerm;

  const listParams = useMemo(
    () => ({
      types: [
        DocumentType.Prd,
        DocumentType.ImplementationPlan,
        DocumentType.Doc,
      ],
      ...resolveServerSearch(serverSearchEnabled, debouncedFilterText),
      ...(recencyDays === undefined ? {} : { recencyDays }),
    }),
    [serverSearchEnabled, debouncedFilterText, recencyDays]
  );
  const {
    data: unboundedDocuments = [],
    isLoading: isUnboundedLoading,
    isFetching: isUnboundedFetching,
    isError: isUnboundedError,
    refetch: refetchUnbounded,
  } = useDocuments(listParams, {
    enabled: isUnboundedArm && !serverSearchUndecided,
  });

  // The paged arm ALWAYS searches on the server, whatever
  // `documents-index-server-search` says: a term applied in the browser to one
  // page of rows would call a match on page four "no results".
  const pagedSearchParams = useMemo(
    () => resolveServerSearch(true, debouncedFilterText),
    [debouncedFilterText]
  );
  const pagedSearch = pagedSearchParams.search;
  // Read here for the cursor reset only. `DocumentsView` reads the same URL +
  // persisted sort for the rows it renders, as `useTableViewPagination` does
  // beside it, so the two cannot disagree about which sort is in force.
  const { sortBy, sortDir } = useSortParams<SortKey>({
    validColumns: SORT_KEYS,
    defaultColumn: SortKey.StackRank,
    defaultDirection: "asc",
    persistenceKey: sortKey,
  });
  const paging = useDocumentsIndexPaging({
    identity: {
      pageSizeStorageKey: pageSizeKey,
      search: pagedSearch,
      sortBy,
      sortDir,
      recencyDays,
    },
    scrollContainer,
  });
  const pagedParams = useMemo(
    () => ({
      types: [
        DocumentType.Prd,
        DocumentType.ImplementationPlan,
        DocumentType.Doc,
      ],
      ...pagedSearchParams,
      ...(recencyDays === undefined ? {} : { recencyDays }),
      limit: paging.pageSize,
      offset: paging.offset,
    }),
    [pagedSearchParams, paging.pageSize, paging.offset, recencyDays]
  );
  const placeholderData = useMemo(
    () =>
      buildDocumentsIndexPlaceholder({
        pageSize: paging.pageSize,
        search: pagedSearch,
        recencyDays,
      }),
    [paging.pageSize, pagedSearch, recencyDays]
  );
  const isPagedReadEnabled = isPagedArm && paging.isPageSizeReady;
  const {
    data: envelope,
    isLoading: isPagedLoading,
    isFetching: isPagedFetching,
    isError: isPagedError,
    isPlaceholderData,
    refetch: refetchPaged,
  } = useDocumentsPage(pagedParams, {
    enabled: isPagedReadEnabled,
    placeholderData,
  });

  const envelopeRead = readDocumentsIndexEnvelope({
    envelope,
    isPlaceholderData,
    requestedPage: paging.page,
    requestedPageSize: paging.pageSize,
  });
  const {
    pagedItems,
    total,
    effectivePageSize,
    hasSettledEnvelope,
    isOutOfRange,
  } = envelopeRead;
  useDocumentsIndexPageClamp({
    enabled: isPagedReadEnabled,
    hasData: hasSettledEnvelope,
    isFetching: isPagedFetching,
    page: paging.page,
    // Measured in the size the server SERVED, the same unit the cursor's
    // offset is strided in once a page has been turned.
    pageSize: effectivePageSize,
    setPage: paging.setPage,
    total,
  });
  const summaryParams = useMemo(
    () => ({
      types: [
        DocumentType.Prd,
        DocumentType.ImplementationPlan,
        DocumentType.Doc,
      ],
      ...pagedSearchParams,
      ...(recencyDays === undefined ? {} : { recencyDays }),
    }),
    [pagedSearchParams, recencyDays]
  );

  const updateDocument = useUpdateDocument();
  const orgUsers = useOrgUsersAsPopoverUsers();

  const editHandlers: RowEditHandlers = useMemo(
    () => ({
      teamMembers: orgUsers,
      onUpdateAssignee: (id, assigneeId) =>
        updateDocument.mutate({
          id,
          assigneeId,
          surface: ArtifactStatusEditSurface.InlineCell,
        }),
      onUpdatePriority: (id, priority: Priority | null) =>
        updateDocument.mutate({
          id,
          priority,
          surface: ArtifactStatusEditSurface.InlineCell,
        }),
      onUpdateStatus: (id, status, surface) =>
        updateDocument.mutate({
          id,
          status,
          surface,
        }),
    }),
    [orgUsers, updateDocument.mutate]
  );

  // ISS-9724 (AC5): between a keystroke and the debounce firing, the rows on
  // screen answer the PREVIOUS term. The client filter would narrow them to zero
  // and both bodies would call that "no results" — a settled verdict about a read
  // that has not been issued yet, which is the still-arriving-page-looks-empty
  // defect the acceptance criterion names. There genuinely is no settled read for
  // the query the reader is now asking, which is what `isLoading` means, so the
  // surface says loading until the term it is showing results for is the term in
  // the box. The paged arm searches on the server unconditionally, so it is in
  // that window whenever the box and the debounced term disagree.
  const isSearchTermSettling = resolveSearchTermSettling({
    debouncedFilterText,
    filterText,
    isPagedArm,
    serverSearchEnabled,
    serverSearchUndecided,
  });
  // Neither read has been issued while the gate that picks between them — or
  // the ladder that sizes the paged one — is still resolving. That is a read
  // still to come, not an empty index, so it reads as loading.
  const isReadUndecided =
    !pagedReady || (isPagedArm && !paging.isPageSizeReady);
  const isHeld = isSearchTermSettling || isReadUndecided || isOutOfRange;
  // No pager until a read has answered: a strip over the first skeleton would
  // count pages nothing has measured. Pinned, not hidden, once rows exist and
  // the page on screen is not the one the cursor names — and pinned through
  // every hold the body shows as loading, since a Next taken over the
  // search-settling skeleton would move the cursor only for the settled term's
  // identity reset to throw it back to 0.
  const isPagerUnsettled = isPlaceholderData || isHeld;
  const pagination =
    isPagedArm && envelope !== undefined
      ? buildDocumentsIndexPagination({
          envelopeRead,
          isPagerUnsettled,
          paging,
        })
      : undefined;

  // The arm is selected ONCE, not once per field: a ternary per field would let
  // the rows of one read pair with the error, refetch, or search provenance of
  // the other. `searchAppliedUpstream` is ISS-9762 — whether the ROWS were
  // already narrowed before they arrived. The container is the only thing that
  // knows (`resolveServerSearch` holds the term back for a blank or over-long
  // one even with the gate open), and a body that read the gate instead would
  // call a settled zero-match read an empty organization on those two paths.
  const read = isPagedArm
    ? {
        documents: pagedItems,
        isLoading: isPagedLoading,
        isFetching: isPagedFetching,
        isError: isPagedError,
        refetch: refetchPaged,
        searchAppliedUpstream: pagedSearch !== undefined,
      }
    : {
        documents: unboundedDocuments,
        isLoading: isUnboundedLoading,
        isFetching: isUnboundedFetching,
        isError: isUnboundedError,
        refetch: refetchUnbounded,
        searchAppliedUpstream: listParams.search !== undefined,
      };

  return (
    <ArtifactList
      {...read}
      editHandlers={editHandlers}
      filterText={filterText}
      isFetching={read.isFetching || isHeld}
      isLoading={read.isLoading || isHeld}
      isServerPaged={isPagedArm}
      isSummaryUnsettled={
        debouncedFilterText !== filterText || isReadUndecided || read.isLoading
      }
      onFilterTextChange={setFilterText}
      onRecencyDaysChange={setRecencyDays}
      onRequestCreate={onRequestCreate ?? undefined}
      pagination={
        pagination ? (
          <DocumentsIndexPaginationFooter pagination={pagination} />
        ) : undefined
      }
      renderBulkActions={(documents, onClear, onRetain) => (
        <DocumentsPrototypeBulkActions
          documents={documents}
          onClear={onClear}
          onRetain={onRetain}
          users={orgUsers}
        />
      )}
      searchParams={summaryParams}
      setScrollContainer={setScrollContainer}
      sortPersistenceKey={sortKey}
      storageKey={expansionStorageKey}
    />
  );
}

/**
 * The `search` slice of the list params — `{}` when the term is not going to the
 * server (ISS-9724).
 *
 * OMITTED rather than sent as an empty string on every off-path. The wire
 * contract rejects a blank term with a 400 (silently dropping one would answer
 * with the whole population while the box still showed text), and omission is
 * also what keeps the flag-off query key byte-identical to today's, so turning
 * the flag on is a new key rather than a changed meaning for the old one.
 *
 * A term past {@link DOCUMENT_LIST_MAX_SEARCH_LENGTH} is held back for a
 * different reason: the endpoint answers it with a 400, and this surface turns a
 * failed read with no cached rows into the whole-page "Couldn't load documents"
 * state — so pasting a long string would blank the index rather than narrow it.
 * Falling back to the unsearched read leaves the client filter to narrow the
 * rows, which is exactly what the flag-off arm does and cannot mislead: the
 * whole population is on screen, so the filter answers over all of it (the
 * paged arm defers to the unbounded read for that term for the same reason).
 */
function resolveServerSearch(
  enabled: boolean,
  term: string
): { search?: string } {
  const trimmed = term.trim();
  if (
    !enabled ||
    trimmed === "" ||
    trimmed.length > DOCUMENT_LIST_MAX_SEARCH_LENGTH
  ) {
    return {};
  }
  return { search: trimmed };
}

/**
 * Whether the rows on screen answer the PREVIOUS term (ISS-9724, AC5).
 *
 * Module-level rather than inline for the reason `renderSummaryBand` is: the
 * operator sequence is scored against this function instead of
 * `DocumentsIndexView`, which sits at the cognitive-complexity ceiling. Pure, and
 * the same expression it replaced.
 *
 * Between a keystroke and the debounce firing, the client filter would narrow the
 * rows to zero and both bodies would call that "no results" — a settled verdict
 * about a read that has not been issued yet. There genuinely is no settled read
 * for the query the reader is now asking, which is what `isLoading` means, so the
 * surface says loading until the term it is showing results for is the term in the
 * box. The paged arm searches on the server unconditionally, so it is in that
 * window whenever the box and the debounced term disagree.
 */
function resolveSearchTermSettling({
  debouncedFilterText,
  filterText,
  isPagedArm,
  serverSearchEnabled,
  serverSearchUndecided,
}: {
  debouncedFilterText: string;
  filterText: string;
  isPagedArm: boolean;
  serverSearchEnabled: boolean;
  serverSearchUndecided: boolean;
}): boolean {
  return (
    serverSearchUndecided ||
    ((serverSearchEnabled || isPagedArm) && debouncedFilterText !== filterText)
  );
}
