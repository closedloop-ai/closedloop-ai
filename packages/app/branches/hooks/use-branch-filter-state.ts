"use client";

import { TABLE_PAGE_SIZE_OPTIONS_EXTENDED } from "@repo/design-system/components/ui/table-page-size-select";
import { usePath } from "@repo/navigation/use-path";
import { useSearchParamsValue } from "@repo/navigation/use-search-params-value";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useFeatureFlagGateOptional } from "../../shared/feature-flags/use-feature-flag-enabled";
import { usePaginatedFilterState } from "../../shared/hooks/use-paginated-filter-state";
import { useReplaceListParams } from "../../shared/hooks/use-replace-list-params";
import { useTablePageSizeOptions } from "../../shared/hooks/use-table-page-size-options";
import { initialFacetParamsSource } from "../../shared/lib/facet-filter-params";
import { GRIDVIEW_ADOPTION_FEATURE_FLAG_KEY } from "../../shared/lib/feature-flags";
import {
  BRANCH_PAGE_SIZE,
  hasBranchPageSizeParam,
  normalizeBranchFiltersForMode,
  parseBranchFilterParams,
  parseBranchGroupViewParams,
  parseBranchPageParam,
  parseBranchPageSizeParam,
  withoutUnsupportedBranchTagFilter,
  writeBranchFilterParams,
  writeBranchPageParam,
  writeBranchPageSizeParam,
} from "../lib/branch-filter-params";
import {
  type BranchFilters,
  type BranchRow,
  DEFAULT_BRANCH_FILTERS,
  filterBranchRows,
} from "../lib/branch-row";
import {
  type BranchGroupViewSource,
  useBranchGroupViewUrlState,
} from "./use-branch-group-view-url-state";

/**
 * Owns the filter + pagination state for the Branches table, shared by the web
 * `/branches` page and the desktop Branches view so both surfaces stay in sync
 * (PRD-454). Callers pass the row set (sample rows today, real branch rows once
 * the data layer lands) and render the returned slices; resetting to page 0 on
 * a filter change lives here so neither surface can forget it.
 *
 * Thin wrapper over the shared {@link usePaginatedFilterState} — this keeps the
 * Branches-specific filter type/function/defaults while the pagination + page-
 * clamp machinery (incl. the FEA-2540 persist-clamp) lives in one place.
 */
export function useBranchFilterState(
  rows: BranchRow[],
  pageSize: number = BRANCH_PAGE_SIZE,
  initialFilters: BranchFilters = DEFAULT_BRANCH_FILTERS,
  approved = false,
  now?: number
) {
  // `initialFilters` seeds the FIRST render (FEA-3560: the pages parse it from
  // the list URL so a detail→back restore reopens the filtered view); later
  // changes flow through `handleFiltersChange`, so this is not a controlled
  // `filters` prop.
  return usePaginatedFilterState(
    rows,
    useCallback(
      (items: BranchRow[], filters: BranchFilters) =>
        filterBranchRows(items, filters, { approved, now }),
      [approved, now]
    ),
    DEFAULT_BRANCH_FILTERS,
    pageSize,
    initialFilters
  );
}

/**
 * {@link useBranchFilterState} plus the FEA-3560 URL mirroring, shared by the
 * web `/branches` page and the desktop Branches view so the seed-from-URL and
 * write-through glue exists once instead of per surface: the facet filters are
 * seeded from the list URL on mount (restoring a detail→back / reload), and the
 * returned `handleFiltersChange` mirrors every change back into the URL via a
 * history-neutral `replace`. Pagination stays client-side state here, so only
 * filter changes touch the URL.
 */
export function useUrlSyncedBranchFilterState(
  rows: BranchRow[],
  pageSize: number = BRANCH_PAGE_SIZE,
  approved = false,
  now?: number,
  /**
   * ISS-9582: re-asserts the grouping and collapse params on this hook's
   * replaces, for the same stale-snapshot reason the facets are re-asserted.
   */
  writeViewParams?: (params: URLSearchParams) => void,
  /**
   * ISS-12456: whether the host's source can serve `tags`. A host that cannot
   * states it here, and the selection is dropped from the filter STATE — see
   * {@link withoutUnsupportedBranchTagFilter} for why state and not the
   * predicate.
   */
  tagsSupported = true
) {
  const searchParams = useSearchParamsValue();
  const routePath = usePath();
  const searchGate = useBranchSearchGate();
  // Mount-only seed; `initialFacetParamsSource` falls back to the browser URL
  // while the web App Router snapshot is still reconciling (empty) on a
  // reload/deep link. On the desktop hash router the fallback never fires
  // (`location.search` sits outside the hash). ISS-8187: the path scopes that
  // fallback to Branches' own URL, so a Sessions `?owner=` still in the address
  // bar mid-transition cannot seed this view.
  const [initialFilters] = useState(() =>
    searchGate.adopt(
      withoutUnsupportedBranchTagFilter(
        normalizeBranchFiltersForMode(
          parseBranchFilterParams(
            initialFacetParamsSource(searchParams, routePath)
          ),
          approved
        ),
        tagsSupported
      )
    )
  );
  const state = useBranchFilterState(
    rows,
    pageSize,
    initialFilters,
    approved,
    now
  );
  const { handleFiltersChange: applyFilters } = state;
  const seededSearch = state.filters.search;
  useEffect(() => {
    if (searchGate.closed && seededSearch !== undefined) {
      applyFilters(searchGate.adopt(state.filters));
    }
  }, [applyFilters, searchGate, seededSearch, state.filters]);
  const replaceFacetParams = useReplaceListParams(searchGate.write);
  const handleFiltersChange = useCallback(
    (next: BranchFilters) => {
      const resolved = searchGate.adopt(
        withoutUnsupportedBranchTagFilter(next, tagsSupported)
      );
      applyFilters(resolved);
      replaceFacetParams(resolved, 0, undefined, writeViewParams);
    },
    [
      applyFilters,
      replaceFacetParams,
      searchGate,
      writeViewParams,
      tagsSupported,
    ]
  );
  // ISS-9582: the grouping gesture's URL write while THIS hook owns the facets
  // (the legacy complete-corpus response), so it cannot restore stale ones.
  const { filters: currentFilters } = state;
  const replaceViewParams = useCallback(
    () => replaceFacetParams(currentFilters, 0, undefined, writeViewParams),
    [replaceFacetParams, currentFilters, writeViewParams]
  );
  const previousMode = useRef(approved);
  useEffect(() => {
    if (previousMode.current === approved) {
      return;
    }
    previousMode.current = approved;
    applyFilters(DEFAULT_BRANCH_FILTERS);
    replaceFacetParams(DEFAULT_BRANCH_FILTERS, 0, undefined, writeViewParams);
  }, [approved, applyFilters, replaceFacetParams, writeViewParams]);
  return { ...state, handleFiltersChange, replaceViewParams };
}

/**
 * URL-backed controls for producer-paged Branches rows.
 *
 * ISS-9692: the URL still wins for rows-per-page — a shared or bookmarked link
 * has to page the way it says it does — but when it carries no `?pageSize=`, the
 * saved view's value is adopted once it has restored. Without that, the choice
 * survived a reload (the param) and was lost the moment the reader navigated
 * away and came back through a link that carried no param, which is the half of
 * "remember my selection" that URL persistence alone cannot do.
 *
 * ISS-9692 (whitlockk review): that adoption is a RENDER-phase derivation, not an
 * effect. As an effect it lost a race it could not win — the host opens its read
 * on the same `isViewReady` this hook is handed, so the query fired on the
 * render where `isRestored` first became true and the effect copying the saved
 * 500 into state ran after it. The reader saw 25 rows and then 500, on the one
 * visit the feature exists for. Derived here, the size is already the remembered
 * one on that first ready render, so there is no order to get wrong.
 */
export function useUrlSyncedBranchServerState(
  persistence?: {
    /** The saved view's page size; ignored until `isRestored`. */
    persistedPageSize?: number;
    /** Whether the saved view has finished restoring (`isViewReady`). */
    isRestored?: boolean;
    /**
     * Whether the restored NAMED view's arrangement has reached the live hooks
     * (`useBranchSavedViewsStore`). Defaults to `true` for a surface with no named
     * views, which is the same "nothing to wait for" answer that hook gives a
     * memory-only collection.
     */
    isArrangementSettled?: boolean;
    /** Write the reader's choice back to the saved view. */
    onPageSizePersist?: (pageSize: number) => void;
    /**
     * ISS-9582: the saved view's grouping and band collapse. A link's `group` /
     * `collapsed` params win over it for the visit, the way `?pageSize=` does.
     */
    groupView?: BranchGroupViewSource;
  },
  /** ISS-12456 @see useUrlSyncedBranchFilterState */ tagsSupported = true
) {
  const searchParams = useSearchParamsValue();
  const routePath = usePath();
  const searchGate = useBranchSearchGate();
  const [initialState] = useState(() => {
    const params = initialFacetParamsSource(searchParams, routePath);
    return {
      filters: searchGate.adopt(
        withoutUnsupportedBranchTagFilter(
          normalizeBranchFiltersForMode(parseBranchFilterParams(params), true),
          tagsSupported
        )
      ),
      page: parseBranchPageParam(params),
      pageSize: parseBranchPageSizeParam(
        params,
        BRANCH_GRID_TABLE_V2_PAGE_SIZE_OPTIONS,
        BRANCH_GRID_TABLE_V2_PAGE_SIZE
      ) as BranchGridTableV2PageSize,
      // Whether the LINK asked for a size, as opposed to falling back to the
      // default. The parsed value cannot answer that — an explicit `?pageSize=25`
      // and no param at all both parse to 25 — and adopting the saved view over
      // an explicit param would make a shared link page differently for whoever
      // opens it.
      hasUrlPageSize: hasBranchPageSizeParam(params),
      groupView: parseBranchGroupViewParams(params),
    };
  });
  const groupView = useBranchGroupViewUrlState(
    initialState.groupView,
    persistence?.groupView
  );
  const { writeViewParams } = groupView;
  const [filters, setFilters] = useState(initialState.filters);
  useEffect(() => {
    if (searchGate.closed && filters.search !== undefined) {
      setFilters(searchGate.adopt(filters));
    }
  }, [searchGate, filters]);
  const [page, setPageState] = useState(initialState.page);
  // ISS-9692: the size STATED here — by the link that opened this visit, by the
  // reader moving the control since, or (ISS-9447 M5) by a named saved view they
  // applied since. Non-null outranks the passive restore of the saved view;
  // `null` means nothing has been stated and that restore is free to supply one
  // the moment it lands.
  const [statedPageSize, setStatedPageSize] =
    useState<BranchGridTableV2PageSize | null>(
      initialState.hasUrlPageSize ? initialState.pageSize : null
    );
  const persistedPageSize = persistence?.persistedPageSize;
  const isRestored = persistence?.isRestored ?? false;
  const isArrangementSettled = persistence?.isArrangementSettled ?? true;
  // The adoption itself. Derived, so on the FIRST render where the saved view is
  // restored this is already the remembered size — the render the host's read
  // gate is also watching.
  const storedPageSize =
    statedPageSize ??
    (isRestored && persistedPageSize !== undefined
      ? normalizeBranchPageSize(persistedPageSize, initialState.pageSize)
      : initialState.pageSize);
  // ISS-9692: the size this surface actually REQUESTS, RENDERS, and writes to
  // the URL — the stored choice resolved against the ladder the
  // `table-page-size-ladder` flag puts in force. Resolved here rather than at
  // each host so both hosts cannot disagree, and so the value stays inside the
  // literal union the Branches wire contract accepts. Every ladder rung is in
  // `BRANCH_GRID_TABLE_V2_PAGE_SIZE_OPTIONS`, so the narrowing below never
  // actually falls back — it is what proves that to the compiler.
  //
  // ISS-9692 (whitlockk review): `isPageSizeReady` is surfaced to the host for the
  // same reason the adoption moved into render — until the flag answers, a
  // stored 500 resolves to 100, and a read issued on that value is a page the
  // reader did not ask for.
  const { isReady: isPageSizeReady, pageSize: offeredPageSize } =
    useTablePageSizeOptions(storedPageSize);
  const pageSize = normalizeBranchPageSize(offeredPageSize, storedPageSize);
  const replaceParams = useReplaceListParams(
    searchGate.write,
    writeBranchPageParam
  );
  const writeCurrentPageSize = useCallback(
    (params: URLSearchParams) => {
      writeBranchPageSizeParam(
        params,
        pageSize,
        BRANCH_GRID_TABLE_V2_PAGE_SIZE
      );
      writeViewParams(params);
    },
    [pageSize, writeViewParams]
  );
  const setPage = useCallback(
    (nextPage: number) => {
      const normalized = Math.max(0, Math.floor(nextPage));
      setPageState(normalized);
      replaceParams(filters, normalized, undefined, writeCurrentPageSize);
    },
    [filters, replaceParams, writeCurrentPageSize]
  );
  const handleFiltersChange = useCallback(
    (nextFilters: BranchFilters, appliedPageSize?: number) => {
      const resolved = searchGate.adopt(
        withoutUnsupportedBranchTagFilter(nextFilters, tagsSupported)
      );
      setFilters(resolved);
      setPageState(0);
      // ISS-9447 M5: a named saved view states a rows-per-page the way it states
      // the sort and the columns, and applying one is a choice the reader makes
      // NOW — so it replaces whatever this visit had stated, the opening link's
      // `?pageSize=` included. Without that, the applied size reached the saved
      // view but never the table, while the switcher went on calling the view
      // unmodified.
      //
      // It rides the SAME params snapshot as the facets and the page reset
      // rather than a second `replace` (the ISS-4728 trap), so a reload after
      // the switch reopens on the size the view names instead of resurrecting
      // the superseded one from the URL.
      const stated =
        appliedPageSize === undefined
          ? undefined
          : normalizeBranchPageSize(appliedPageSize, storedPageSize);
      if (stated !== undefined) {
        setStatedPageSize(stated);
      }
      replaceParams(resolved, 0, undefined, (params) => {
        writeBranchPageSizeParam(
          params,
          stated ?? pageSize,
          BRANCH_GRID_TABLE_V2_PAGE_SIZE
        );
        writeViewParams(params);
      });
    },
    [
      replaceParams,
      pageSize,
      searchGate,
      storedPageSize,
      writeViewParams,
      tagsSupported,
    ]
  );
  const onPageSizePersist = persistence?.onPageSizePersist;
  const setPageSize = useCallback(
    (nextPageSize: number) => {
      const normalized = normalizeBranchPageSize(nextPageSize, storedPageSize);
      setStatedPageSize(normalized);
      setPageState(0);
      replaceParams(filters, 0, undefined, (params) => {
        writeBranchPageSizeParam(
          params,
          normalized,
          BRANCH_GRID_TABLE_V2_PAGE_SIZE
        );
        writeViewParams(params);
      });
      // ISS-9692: the same choice, written to the saved view as well as the URL.
      // The URL is the shareable statement about THIS visit; the saved view is
      // what the reader gets on the next one.
      onPageSizePersist?.(normalized);
    },
    [filters, storedPageSize, replaceParams, onPageSizePersist, writeViewParams]
  );
  // ISS-9582: a grouping or band change writes the URL in one replace that
  // carries the facets, page and size from state. `resolveBranchPageState`
  // picks THIS writer or the legacy hook's — whichever owns the facets on
  // screen — and runs it after `commitGrouping` / `commitCollapsedGroups`.
  const replaceViewParams = useCallback(
    () => replaceParams(filters, page, undefined, writeCurrentPageSize),
    [replaceParams, filters, page, writeCurrentPageSize]
  );
  return {
    /**
     * ISS-9582: applies a saved view's arrangement and drops the link's
     * grouping statement; the filter apply that follows writes the URL.
     */
    applyArrangement: groupView.applyArrangement,
    collapsedGroups: groupView.collapsedGroups,
    commitCollapsedGroups: groupView.setCollapsedGroups,
    commitGrouping: groupView.setGrouping,
    grouping: groupView.grouping,
    replaceViewParams,
    /**
     * Handed to the legacy URL hook so its replaces keep the grouping, collapse
     * and rows-per-page params. The legacy hook has no page-size writer, so a
     * band toggle before the snapshot reconciles would otherwise drop a
     * `pageSize` this hook just wrote.
     */
    writeViewParams: writeCurrentPageSize,
    filters,
    handleFiltersChange,
    isPageSizeReady,
    /**
     * ISS-9692 (whitlockk review) — whether this reader should be read at all yet:
     * the live saved view has restored, the ladder flag has answered, AND the
     * restored NAMED view's arrangement has reached the live hooks.
     *
     * Composed HERE rather than at each host, because both hosts gate the same
     * read on the same facts and an `&&` written twice is two answers.
     *
     * ISS-9447 (review) added the third. `isRestored` is `isViewReady`, which
     * watches the LIVE view and knows nothing about a named one — so an active
     * 100-row saved view over a live 25-row state opened the first server read
     * at 25 and replaced it at 100, the exact ISS-9692 double read arriving
     * through the rows-per-page axis M5 added. The signal already existed
     * (`isArrangementSettled`, consumed by both hosts' cohort gates since
     * ISS-8127); it was simply absent from the read gate.
     *
     * All three fail open on their own — `isViewReady` on
     * `VIEW_RESTORE_AUTH_DEADLINE_MS`, the ladder flag on its own deadline, and
     * the arrangement flag on there being no storage key to wait for — so the
     * worst case is the pre-gate double read rather than a list that never loads.
     */
    isReadReady: isRestored && isPageSizeReady && isArrangementSettled,
    page,
    pageSize,
    setPage,
    setPageSize,
  };
}

/**
 * ISS-9225: the URL accepts exactly what the footer OFFERS, read from the one
 * place that states the ladder. It read a second `[25, 50, 100]` in
 * `branch-list-contract.ts` until this ticket, so a rung added to the shared
 * control would have rendered on Branches and then been rejected by this list's
 * own `?pageSize=`.
 *
 * ISS-9692: the EXTENDED ladder, for the same reason `BRANCH_LIST_MAX_LIMIT` is
 * raised unconditionally — this is an ACCEPTANCE set, not an offer. Left on the
 * base ladder it accepted only 25/50/100, so `normalizeBranchPageSize` below
 * silently returned the current size for a 250 or a 500: the footer offered the
 * two large rungs with the flag on, the reader picked one, and NOTHING happened
 * — no request, no error, the select snapping back. What a reader is OFFERED is
 * still gated, by `useTablePageSizeOptions` at the footer; a value that can
 * never be produced by a closed gate costs nothing to accept, and a stale one
 * is resolved back down before it reaches the query.
 */
export const BRANCH_GRID_TABLE_V2_PAGE_SIZE_OPTIONS =
  TABLE_PAGE_SIZE_OPTIONS_EXTENDED;
export const BRANCH_GRID_TABLE_V2_PAGE_SIZE =
  BRANCH_GRID_TABLE_V2_PAGE_SIZE_OPTIONS[0];
type BranchGridTableV2PageSize =
  (typeof BRANCH_GRID_TABLE_V2_PAGE_SIZE_OPTIONS)[number];

function normalizeBranchPageSize(
  nextPageSize: number,
  currentPageSize: BranchGridTableV2PageSize
): BranchGridTableV2PageSize {
  return BRANCH_GRID_TABLE_V2_PAGE_SIZE_OPTIONS.includes(
    nextPageSize as BranchGridTableV2PageSize
  )
    ? (nextPageSize as BranchGridTableV2PageSize)
    : currentPageSize;
}

/**
 * ISS-9437 — return to page 0 when the producer changes the status ordering it
 * serves (`BranchesPageDataQuery.servedStatusOrdering`).
 *
 * A new query key is a new cache entry, not a page reset: the reader's offset
 * survives it, and after a producer-side flip that offset names a slice of a
 * differently-ordered list. So the reset is explicit.
 *
 * Only a STATED-to-STATED change resets. The FIRST observation (`null` → a name)
 * is the clock answering for the first time, not a flip — resetting on it would
 * discard the page a deep link asked for, on every mount. An ordering going
 * ABSENT is not a flip either: absent is what a producer predating the field and
 * a producer whose flag evaluation was unavailable both look like, and neither
 * is evidence the order moved.
 *
 * It lives beside `page`/`setPage` rather than in the read hook, which holds no
 * page state at all. Hosts call it after their read, because the value it
 * watches comes from that read.
 */
export function useBranchServedStatusOrderingReset(
  servedStatusOrdering: string | null | undefined,
  setPage: (page: number) => void
): void {
  const previousServedStatusOrdering = useRef<string | null>(null);
  useEffect(() => {
    if (!servedStatusOrdering) {
      return;
    }
    const previous = previousServedStatusOrdering.current;
    previousServedStatusOrdering.current = servedStatusOrdering;
    if (previous !== null && previous !== servedStatusOrdering) {
      setPage(0);
    }
  }, [servedStatusOrdering, setPage]);
}

/**
 * ISS-13035: the Branches search term belongs to `gridview-adoption`, the flag
 * that shows the toolbar's search box. This module's one read of it. While the
 * flag is unresolved the URL's term is kept, because it can still turn out
 * enabled and the mount-only seed is not re-read; only a flag known to be
 * closed strips a term (`closed`), and the hooks below drop an already-seeded
 * one when that happens. Open, every write states the term, so clearing the
 * filters removes the param too.
 */
function useBranchSearchGate() {
  const { enabled, isReady } = useFeatureFlagGateOptional(
    GRIDVIEW_ADOPTION_FEATURE_FLAG_KEY
  );
  const closed = isReady && !enabled;
  return useMemo(
    () => ({
      adopt: (filters: BranchFilters): BranchFilters => {
        if (!closed || filters.search === undefined) {
          return filters;
        }
        const { search: _search, ...withoutSearch } = filters;
        return withoutSearch;
      },
      closed,
      write: (params: URLSearchParams, filters: BranchFilters) =>
        writeBranchFilterParams(
          params,
          enabled ? { search: "", ...filters } : filters
        ),
    }),
    [closed, enabled]
  );
}
