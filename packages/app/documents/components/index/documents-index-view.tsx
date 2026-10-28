"use client";

import { ArtifactStatusEditSurface } from "@repo/api/src/types/artifact-status-contract";
import type { Priority } from "@repo/api/src/types/common";
import {
  DOCUMENT_LIST_MAX_SEARCH_LENGTH,
  DocumentType,
  type FindDocumentsOptions,
} from "@repo/api/src/types/document";
import type { DocumentsIndexBodyProps } from "@repo/app/documents/components/index/documents-index-body-props";
import { DocumentsIndexBodyV1 } from "@repo/app/documents/components/index/documents-index-body-v1";
import { DocumentsIndexBodyV2 } from "@repo/app/documents/components/index/documents-index-body-v2";
import {
  DOCUMENTS_INDEX_COLUMN_ORDER_KEY,
  DOCUMENTS_INDEX_COLUMN_VISIBILITY_KEY,
  DOCUMENTS_INDEX_PAGE_SIZE_KEY,
  DOCUMENTS_INDEX_SCROLL_KEY,
  DOCUMENTS_INDEX_SEARCH_KEY,
  DOCUMENTS_INDEX_SORT_KEY,
  DOCUMENTS_INDEX_STORAGE_KEY,
} from "@repo/app/documents/components/index/documents-index-keys";
import { DocumentsSummaryBand } from "@repo/app/documents/components/index/documents-summary-band";
import { DocumentTableToolbar } from "@repo/app/documents/components/table/document-table-toolbar";
import type { RowEditHandlers } from "@repo/app/documents/components/table/row-edit-context";
import {
  SORT_KEYS,
  SortKey,
} from "@repo/app/documents/components/table/sort-keys";
import { useDeleteRowItem } from "@repo/app/documents/hooks/use-delete-row-item";
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
import type { DocumentsSummaryRow } from "@repo/app/documents/lib/documents-summary-cards";
import {
  useFeatureFlagEnabled,
  useFeatureFlagGate,
} from "@repo/app/shared/feature-flags/use-feature-flag-enabled";
import {
  DocumentColumn,
  useColumnVisibility,
} from "@repo/app/shared/hooks/use-column-visibility";
import { useDebouncedValue } from "@repo/app/shared/hooks/use-debounced-value";
import { useScrollRestore } from "@repo/app/shared/hooks/use-scroll-restore";
import { useSortParams } from "@repo/app/shared/hooks/use-sort-params";
import { useViewStateKey } from "@repo/app/shared/hooks/use-view-state-key";
import { useViewStatePersistence } from "@repo/app/shared/hooks/use-view-state-persistence";
import {
  DOCUMENTS_INDEX_PAGED_FEATURE_FLAG_KEY,
  DOCUMENTS_INDEX_SERVER_SEARCH_FEATURE_FLAG_KEY,
  DOCUMENTS_INDEX_STATES_FEATURE_FLAG_KEY,
  DOCUMENTS_INDEX_SUMMARY_CARDS_FEATURE_FLAG_KEY,
} from "@repo/app/shared/lib/feature-flags";
import { useOrgUsersAsPopoverUsers } from "@repo/app/users/hooks/use-org-users-as-popover-users";
import { type ReactNode, useMemo, useState } from "react";

/**
 * Org-level Documents index (FEA-4140). Lists the org's DOC artifacts, filed
 * into a project or not (ISS-12858), at org scope, reusing the shared document
 * table pipeline (`DocumentsView` + `DocumentTableToolbar`) exactly as the
 * project page and My Tasks do. There is no project chrome (no per-type tabs,
 * no branches/features), so the view renders a single flat DOC list.
 *
 * ISS-8940: this component owns the read, the toolbar, and the persisted view
 * state, and is the ONE place the page consults `documents-index-states`. What
 * that read means — which of six states the surface is in — belongs entirely to
 * the selected body, so neither body receives the boolean and neither can
 * branch on it internally.
 *
 * ISS-9157: it is also the ONE place the page consults `documents-index-paged`,
 * which selects between two reads of `GET /documents` — the shipped unbounded
 * read, or one server page with the real total — and never changes the shape
 * of either. The bodies receive the rows and, on the paged arm, a pagination
 * descriptor; they never receive the flag.
 */

// The index is hard-filtered to a single type (DocumentType.Doc), so a Type
// column would be a column of identical "Doc" values — dropped here (the
// project page hides it the same way when a filter pins one type).
const DOCUMENTS_INDEX_COLUMNS: DocumentColumn[] = [
  DocumentColumn.Assignee,
  DocumentColumn.Updated,
];

export function DocumentsIndexView() {
  const sixStatesEnabled = useFeatureFlagEnabled(
    DOCUMENTS_INDEX_STATES_FEATURE_FLAG_KEY
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
  const columnVisibilityKey = useViewStateKey(
    DOCUMENTS_INDEX_COLUMN_VISIBILITY_KEY
  );
  const columnOrderKey = useViewStateKey(DOCUMENTS_INDEX_COLUMN_ORDER_KEY);
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

  // PRD-799 G-04 (ISS-12858): a DOC filed into a project stays on this list, so
  // the read carries no project filter. lc-debt: the read no longer matches the
  // ISS-9776 partial index `artifacts_org_type_subtype_created_id_idx`
  // (`project_id IS NULL`); PRD-798's list rebuild owns the replacement access
  // path.
  const listParams = useMemo(
    () => ({
      type: DocumentType.Doc,
      ...resolveServerSearch(serverSearchEnabled, debouncedFilterText),
    }),
    [serverSearchEnabled, debouncedFilterText]
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
    },
    scrollContainer,
  });
  const pagedParams = useMemo(
    () => ({
      type: DocumentType.Doc,
      ...pagedSearchParams,
      limit: paging.pageSize,
      offset: paging.offset,
    }),
    [pagedSearchParams, paging.pageSize, paging.offset]
  );
  const placeholderData = useMemo(
    () =>
      buildDocumentsIndexPlaceholder({
        pageSize: paging.pageSize,
        search: pagedSearch,
      }),
    [paging.pageSize, pagedSearch]
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
  const { visibility, toggleColumn, visibleColumns, reorderColumns } =
    useColumnVisibility({
      storageKey: columnVisibilityKey,
      orderStorageKey: columnOrderKey,
      defaults: {},
      columns: DOCUMENTS_INDEX_COLUMNS,
    });

  // ISS-8936: the ONE place this page consults `documents-index-summary-cards`.
  // The bare flag rather than the gate, because "off" and "not answered yet" want
  // the SAME rendering here — no band — so there is nothing for a gate to hold
  // back. What the answer selects is a whole shape: `DocumentsSummaryBand` owns
  // the summary read entirely, so a closed reader mounts no query at all rather
  // than a disabled one, and the boolean never reaches a derivation.
  const summaryCardsEnabled = useFeatureFlagEnabled(
    DOCUMENTS_INDEX_SUMMARY_CARDS_FEATURE_FLAG_KEY
  );
  // The band's filters are the list's filters, with the term ALWAYS sent to the
  // server. That is not a second opinion about the search: the band holds no rows,
  // so a term it did not send is a term it did not apply, and it would count the
  // whole population under a search that narrowed the table. The two predicates
  // agree by construction — `buildDocumentSearchFilter`'s case-insensitive
  // substring over title/slug is the semantics the client-side `matchesFilter`
  // applies to the same two fields — so the flag-off client-filter arm reconciles
  // with the band too.
  const summaryParams = useMemo(
    () => ({
      type: DocumentType.Doc,
      ...pagedSearchParams,
    }),
    [pagedSearchParams]
  );

  const updateDocument = useUpdateDocument();
  const handleDelete = useDeleteRowItem();
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

  const bodyProps: DocumentsIndexBodyProps = {
    ...read,
    isLoading: read.isLoading || isHeld,
    isFetching: read.isFetching || isHeld,
    filterText,
    // Counted after the server search — see `DocumentsIndexBodyProps` for why
    // that is safe on this surface and nowhere else.
    hasUnpagedItems: isPagedArm && hasSettledEnvelope ? total > 0 : undefined,
    pagination,
    editHandlers,
    onDelete: handleDelete,
    onReorderColumns: reorderColumns,
    visibleColumns,
    setScrollContainer,
    sortPersistenceKey: sortKey,
    storageKey: expansionStorageKey,
  };

  return (
    <>
      <div className="border-b">
        <DocumentTableToolbar
          filterText={filterText}
          onFilterTextChange={setFilterText}
          tableViewMenuProps={{
            columns: DOCUMENTS_INDEX_COLUMNS,
            onToggle: toggleColumn,
            visibility,
          }}
        />
      </div>
      {/* ISS-8936: the band sits between the filter control and the list it
          summarizes, so a reader applies a filter, reads what it selected, then
          reads the rows — and the toolbar stays pinned at the top of the page. */}
      {summaryCardsEnabled
        ? renderSummaryBand({
            filterText,
            isPopulationUnsettled: resolveSummaryPopulationUnsettled({
              debouncedFilterText,
              filterText,
              isReadUndecided,
              isRowsLoading: read.isLoading,
            }),
            isTermOverLong,
            rows: read.documents,
            searchParams: summaryParams,
          })
        : null}
      {/* The states render BELOW the toolbar so a failed read keeps the search
          box and column menu in place instead of collapsing the whole page to a
          bare retry block (matches My Tasks, Sessions, and Branches). */}
      {sixStatesEnabled ? (
        <DocumentsIndexBodyV2 {...bodyProps} />
      ) : (
        <DocumentsIndexBodyV1 {...bodyProps} />
      )}
    </>
  );
}

/**
 * The summary band's element (ISS-8936).
 *
 * It takes no flag: `documents-index-summary-cards` is branched on at its ONE
 * read site above, which either puts this whole subtree in the tree or puts
 * nothing there, so the boolean never crosses into a helper that could steer a
 * derivation with it (AGENTS.md → one read site per feature flag; review thread
 * on #8000).
 *
 * Module-level rather than inline for the reason `renderSummaryMetricBand` gives
 * about the Sessions surface — the props are scored against this function instead
 * of `DocumentsIndexView`, which sits at the cognitive-complexity ceiling.
 */
function renderSummaryBand({
  filterText,
  isPopulationUnsettled,
  isTermOverLong,
  rows,
  searchParams,
}: {
  /** The term in the box, for the row-counted fallback's own narrowing. */
  filterText: string;
  /**
   * The population the band would describe is not settled yet — the term it is
   * about to send is not the term in the box, the gate that picks the list's read
   * has not answered, or the selected read is still in flight.
   *
   * The term half is deliberately NOT `isSearchTermSettling`, which the list
   * derives: that one is conditioned on the server-search gate, because the LIST
   * can narrow its own rows in the browser while the gate is closed. The band
   * holds no rows and always searches on the server, so for it a term in flight is
   * a term in flight on every arm.
   *
   * `read.isLoading` is in here because the refused-term arm counts {@link rows}:
   * a cold unbounded read hands this an empty array, and without this the band
   * would state four settled zeroes for a population nothing has read yet
   * (review thread on #8000).
   */
  isPopulationUnsettled: boolean;
  isTermOverLong: boolean;
  /**
   * The rows the selected read returned. Spent ONLY on the refused-term arm, which
   * is always the unbounded read — so there they are the whole matching population,
   * not one page.
   */
  rows: readonly DocumentsSummaryRow[];
  searchParams: FindDocumentsOptions;
}): ReactNode {
  return (
    <DocumentsSummaryBand
      // The padding `GridTableListSurface` gives the Sessions and Branches metric
      // bands, and NO rule of its own: the toolbar above already owns the seam, and
      // a second border would fence the numbers off from the rows they describe
      // (visual-qa review).
      className="min-w-0 px-4 pt-4 pb-3"
      filterText={filterText}
      isPopulationUnsettled={isPopulationUnsettled}
      isTermOverLong={isTermOverLong}
      rows={rows}
      searchParams={searchParams}
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

/**
 * Whether the population the summary band would describe is settled (ISS-8936).
 *
 * Deliberately NOT {@link resolveSearchTermSettling}, which is conditioned on the
 * server-search gate because the LIST can narrow its own rows in the browser while
 * that gate is closed. The band holds no rows and always searches on the server,
 * so for it a term in flight is a term in flight on every arm.
 *
 * `isRowsLoading` is in here because the refused-term arm counts the rows on
 * screen: a cold unbounded read hands the band an empty array, and without this
 * the band would state four settled zeroes for a population nothing has read yet
 * (review thread on #8000).
 */
function resolveSummaryPopulationUnsettled({
  debouncedFilterText,
  filterText,
  isReadUndecided,
  isRowsLoading,
}: {
  debouncedFilterText: string;
  filterText: string;
  isReadUndecided: boolean;
  isRowsLoading: boolean;
}): boolean {
  return debouncedFilterText !== filterText || isReadUndecided || isRowsLoading;
}
