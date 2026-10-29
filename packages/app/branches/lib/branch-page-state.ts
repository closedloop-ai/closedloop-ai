import {
  BranchLastActiveClassification,
  classifyBranchLastActive,
} from "@repo/api/src/types/branch-list-cohort";
import type { BranchStatusOrdering } from "@repo/api/src/types/branch-status-order";
import { resolveTotalPages } from "@repo/api/src/utils/math";
import {
  EMPTY_TABLE_COLLAPSED_GROUPS,
  type TableCollapsedGroups,
} from "@repo/app/shared/lib/table-collapsed-groups";
import {
  EMPTY_TABLE_GROUPING,
  type TableGroupingState,
} from "@repo/design-system/components/ui/table-toolbar-model";
import type { BranchFilters, BranchRow } from "./branch-row";
import {
  type BranchSortDir,
  type BranchSortKey,
  sortBranchRows,
} from "./branch-sort-group";

type BranchControlState = {
  filters: BranchFilters;
  page: number;
  setPage: (page: number) => void;
  /**
   * ISS-9447 M5: the optional second argument is the rows-per-page an applied
   * saved view states. Only the server-controls path has a page-size statement
   * to replace; the legacy path ignores it, which is correct — its size is a
   * fixed constant, not a ladder.
   */
  handleFiltersChange: (
    filters: BranchFilters,
    appliedPageSize?: number
  ) => void;
  /**
   * ISS-9582: write the grouping and collapse params, re-asserting THIS
   * controls' facets and page in the same replace.
   */
  replaceViewParams: () => void;
};

type LegacyBranchState = BranchControlState & {
  filteredRows: BranchRow[];
  pagedRows: BranchRow[];
  total: number;
  totalPages: number;
};

type BranchListPopulation = {
  readonly hasMore?: boolean;
  readonly items: readonly unknown[];
  readonly pageInfo?: {
    readonly limit: number;
    readonly offset: number;
  };
  readonly total: number;
};

export type ResolvedBranchPageState = BranchControlState &
  BranchGroupViewHandlers & {
    filteredRows: BranchRow[];
    pagedRows: BranchRow[];
    total: number;
    totalPages: number;
    pageSize: number;
    from: number;
    to: number;
  };

/** Whether the response contains the complete population for the current scope. */
export function branchListHasCompletePopulation(
  data: BranchListPopulation | undefined
): boolean {
  return (
    data !== undefined &&
    data.hasMore !== true &&
    data.items.length === data.total
  );
}

/** Keep server-owned controls stable through the initial/placeholder request. */
export function shouldUseBranchServerControls(
  isPending: boolean,
  isPlaceholderData: boolean,
  serverPageActive: boolean
): boolean {
  return isPending || isPlaceholderData || serverPageActive;
}

/**
 * Keep client window/sort work only on the legacy complete-corpus path.
 *
 * ISS-11915: the window is the shared Last-active classifier the list servers
 * apply, so only a row known to be outside the window drops; a missing,
 * unparseable or future Last active is retained, as the server path retains it.
 *
 * ISS-9437: `statusOrdering` is the resolved ordering the calling shell read the
 * flag for — the shell branches on the flag once and hands down a whole shape,
 * never the boolean. Omitted means today's ordering.
 */
export function resolveBranchDisplayRows(
  rows: BranchRow[],
  input: {
    serverPageActive: boolean;
    startDate?: string;
    endDate?: string;
    sortKey: BranchSortKey;
    sortDir: BranchSortDir;
    statusOrdering?: BranchStatusOrdering;
    evaluationNow?: Date;
  }
): { visibleRows: BranchRow[]; sortedRows: BranchRow[] } {
  if (input.serverPageActive) {
    return { visibleRows: rows, sortedRows: rows };
  }
  const { startDate, endDate } = input;
  const evaluationNow = input.evaluationNow ?? new Date();
  const visibleRows =
    startDate || endDate
      ? rows.filter(
          (row) =>
            classifyBranchLastActive(
              { legacy: row.lastActivityAt },
              { evaluationNow, startDate, endDate }
            ) !== BranchLastActiveClassification.KnownOutOfWindow
        )
      : rows;
  return {
    visibleRows,
    sortedRows: sortBranchRows(
      visibleRows,
      input.sortKey,
      input.sortDir,
      true,
      input.statusOrdering
    ),
  };
}

/** Resolve one pagination/filter state shape for either rollout branch. */
export function resolveBranchPageState(input: {
  serverPageActive: boolean;
  serverControlsActive?: boolean;
  server: BranchControlState & BranchGroupViewCommits;
  legacy: LegacyBranchState;
  data: BranchListPopulation | undefined;
  rows: BranchRow[];
  pageSize: number;
}): ResolvedBranchPageState {
  if (!input.serverPageActive) {
    const { filteredRows, pagedRows, total, totalPages } = input.legacy;
    const controls = input.serverControlsActive ? input.server : input.legacy;
    const { filters, page, setPage, handleFiltersChange, replaceViewParams } =
      controls;
    const derived = { filteredRows, pagedRows, total, totalPages };
    const from = derived.total === 0 ? 0 : page * input.pageSize + 1;
    const to = Math.min((page + 1) * input.pageSize, derived.total);
    return {
      filters,
      page,
      setPage,
      handleFiltersChange,
      replaceViewParams,
      ...groupViewHandlers(input.server, replaceViewParams),
      ...derived,
      pageSize: input.pageSize,
      from,
      to,
    };
  }
  const total = input.data?.total ?? 0;
  const pageSize = input.data?.pageInfo?.limit ?? input.pageSize;
  const page = (input.data?.pageInfo?.offset ?? 0) / pageSize;
  return {
    ...input.server,
    ...groupViewHandlers(input.server, input.server.replaceViewParams),
    page,
    filteredRows: input.rows,
    pagedRows: input.rows,
    total,
    totalPages: resolveTotalPages(total, pageSize),
    pageSize,
    from: total === 0 ? 0 : page * pageSize + 1,
    to: Math.min((page + 1) * pageSize, total),
  };
}

/** Withhold previous-key rows/analytics and data before persisted view restore. */
export function shouldWithholdBranchPageData(
  input: BranchPageDataPresentationInput
): boolean {
  if (!input.isViewReady) {
    return true;
  }
  return input.isPlaceholderData;
}

/** Resolve loading without letting a rejected placeholder hide Retry. */
export function isBranchPageDataPresentationPending(
  input: BranchPageDataPresentationInput & {
    isPending: boolean;
    isError: boolean;
  }
): boolean {
  return (
    input.isPending || (shouldWithholdBranchPageData(input) && !input.isError)
  );
}

/** Return only data owned by the currently selected server-page query key. */
export function selectPresentedBranchPageData<T>(
  pageData: T | undefined,
  input: Omit<BranchPageDataPresentationInput, "pageData">
): T | undefined {
  if (shouldWithholdBranchPageData({ ...input, pageData })) {
    return undefined;
  }
  return pageData;
}

/**
 * The three inputs that decide whether the page data on hand may be presented.
 *
 * An object rather than positional flags because the predicates below already
 * carry multiple booleans between them, and a caller that transposes two of them
 * gets a plausible surface that withholds the wrong thing.
 */
export type BranchPageDataPresentationInput = {
  isPlaceholderData: boolean;
  /**
   * Whether the persisted table view has restored (`usePersistedTableViewState`
   * `isViewReady`).
   *
   * ISS-8127: the restore runs in a POST-MOUNT effect (FEA-4125), so the first
   * commit of every mount still holds the DEFAULT date range. Gating the read
   * on `isViewReady` stops that commit from FETCHING, but a disabled TanStack
   * query is not blind — it still serves whatever is cached under its key, and
   * after a back-navigation the default window's key IS populated, because the
   * first mount fetched under it before the user picked a range. The full
   * corpus and the stale default window therefore co-occur for one commit,
   * which is long enough for the page to narrow the corpus to the trailing
   * default window and POST that as the exact pre-pagination cohort — binding
   * the summary cards to a fraction of the branches the user is looking at.
   *
   * Withholding here is one-way: `isViewReady` fails OPEN once
   * `VIEW_RESTORE_AUTH_DEADLINE_MS` elapses, so this can delay presentation by
   * a commit but can never withhold it permanently.
   */
  isViewReady: boolean;
  pageData?: unknown;
};

function groupViewHandlers(
  commits: BranchGroupViewCommits,
  replaceViewParams: () => void
): BranchGroupViewHandlers {
  return {
    handleCollapsedGroupsChange: (collapsedGroups) => {
      commits.commitCollapsedGroups(collapsedGroups);
      replaceViewParams();
    },
    handleGroupingChange: (grouping) => {
      commits.commitGrouping(grouping);
      replaceViewParams();
    },
  };
}

/** ISS-9582: the grouping view's state updates, owned by the server hook. */
type BranchGroupViewCommits = {
  commitCollapsedGroups: (collapsedGroups: TableCollapsedGroups) => void;
  commitGrouping: (grouping: TableGroupingState) => void;
};

/**
 * ISS-9582: a grouping or band gesture — the state change, then the URL write
 * of whichever controls own the facets on screen. Written against the server
 * hook's facets while the legacy hook owns them, a toggle would put stale
 * filters back in the URL and a reload would open the wrong list.
 */
type BranchGroupViewHandlers = {
  handleCollapsedGroupsChange: (collapsedGroups: TableCollapsedGroups) => void;
  handleGroupingChange: (grouping: TableGroupingState) => void;
};

/**
 * "Reset view" for a host: the persisted reset PLUS the URL-stated grouping.
 *
 * `resetView` only rewrites the saved view, and a reader who opened a link
 * stating `?group=` keeps that statement on screen over the cleared saved view,
 * while a reset after a gesture leaves `group`/`collapsed` in the URL for the
 * next reload. Routing the clear through the grouping handlers drops the link's
 * statement and rewrites the URL in the same gesture.
 */
export function composeBranchResetView(
  resetView: () => void,
  handlers: BranchGroupViewHandlers
): () => void {
  return () => {
    resetView();
    handlers.handleGroupingChange(EMPTY_TABLE_GROUPING);
    handlers.handleCollapsedGroupsChange(EMPTY_TABLE_COLLAPSED_GROUPS);
  };
}
