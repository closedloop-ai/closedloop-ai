import type {
  AgentSessionListItem,
  AgentSessionUsageSummary,
  SessionLinkedArtifact,
} from "@repo/api/src/types/agent-session";
import type { AgentSessionListPageInfo } from "@repo/api/src/types/agent-session-list-contract";
import type { SessionsCsvExportMenuItem } from "@repo/app/agents/components/sessions/sessions-csv-export-menu-item";
import type { SessionCustomDateWindow } from "@repo/app/agents/lib/session-custom-date-window";
import type { SessionFacetFilters } from "@repo/app/agents/lib/session-filter-adapter";
import type { SessionGroupBy } from "@repo/app/agents/lib/session-grouping";
import type {
  SessionSortDir,
  SessionSortKey,
  SessionSortRule,
} from "@repo/app/agents/lib/session-sort-group";
import type { SessionComparisonRead } from "@repo/app/agents/lib/session-summary-deltas";
import type { SessionsListReadState } from "@repo/app/agents/lib/sessions-list-read-state";
import type { TimezoneMode } from "@repo/app/shared/lib/date-window-timezone-mode";
import type { DateRange } from "@repo/app/shared/lib/format-utils";
import type { SortDirection } from "@repo/design-system/components/ui/sortable-column-header";
import type { ReactNode } from "react";
import type { useSessionsGitHubConnectGate } from "./sessions-summary-cards-with-github-connect";

/**
 * ISS-8221 — everything the Sessions page has read, fetched, or derived by the
 * time it picks a listing surface, in ONE value both branches take.
 *
 * The `grid-table-v2` key is deliberately absent, and that absence is the point.
 * The page reads that flag exactly once, at the branch; whichever surface it
 * picks receives this input and nothing else, so no derivation below the branch
 * can ask which surface it is running under. Each surface applies its own
 * behaviour unconditionally instead.
 *
 * One bundle rather than two hand-written prop lists because the two branches
 * being handed DIFFERENT values for the same page state is the defect class this
 * ticket closed: `buildSessionsPaginationFooter` grew a v2 arm whose output the
 * v2 branch never rendered. Built once, there is nothing to keep in step.
 */
export type SessionsSurfaceInput = {
  columnOrder: readonly string[] | undefined;
  columnWidths: Readonly<Record<string, number>>;
  customDateWindow: SessionCustomDateWindow | null;
  dateRange: DateRange;
  effectiveFacetFilters: SessionFacetFilters;
  effectivePageIndex: number;
  errorRecoveryAction: ReactNode;
  facetFilters: SessionFacetFilters;
  getIssueHref: (artifact: SessionLinkedArtifact) => string | null;
  getSessionHref: (item: AgentSessionListItem) => string;
  /** ISS-7866: the Connect-GitHub ask, resolved once for whichever branch renders. */
  githubConnectGate: ReturnType<typeof useSessionsGitHubConnectGate>;
  groupBy: SessionGroupBy;
  handleClearFilters: () => void;
  /**
   * FEA-4201: already wrapped in the page's `gateCustomDateWindowChange`, so a
   * viewer without that flag gets `undefined` and no explicit-window control.
   */
  handleCustomDateWindowChange:
    | ((next: SessionCustomDateWindow | null) => void)
    | undefined;
  handleDateRangeChange: (next: DateRange) => void;
  /**
   * ISS-9619 — the day boundary this page's window means, and its writer. The
   * page reads the gate once and both rollout branches receive the same answer,
   * so neither can window its rows differently from the other's cards.
   */
  timezoneMode: TimezoneMode;
  handleTimezoneModeChange: ((next: TimezoneMode) => void) | undefined;
  handleFiltersChange: (next: SessionFacetFilters) => void;
  handleRemoveSelectedUser: (nextFilters: SessionFacetFilters) => void;
  handleScopeChange: (delta: {
    clearScopeUser: boolean;
    /**
     * ISS-9822: strip the URL-owned `?from=`/`?to=` window with this write. Only
     * the v2 branch's window fold reports one; absent, an inbound window is left
     * exactly where the reader found it.
     */
    clearWindow?: boolean;
    dateRange: DateRange | null;
    facets: SessionFacetFilters;
    /** PRD-721: the new `?search=` term (`""` clears it), or `null` unmoved. */
    search?: string | null;
  }) => void;
  handleSort: (column: string, direction: SortDirection) => void;
  hasActiveFilters: boolean;
  hasConnectedAgent: boolean | undefined;
  /** ISS-11913 @see SessionsListSurfaceV2Props.hasSessionsOutsideWindow */
  hasSessionsOutsideWindow: boolean | undefined;
  /** The reader's stored hidden-card set, BEFORE any menu-availability gate. */
  hiddenSummaryCards: ReadonlySet<string>;
  honestLoadingEnabled: boolean | undefined;
  isListPending: boolean;
  /** The ROW read failed on a read that never landed — not a failed refetch. */
  isListUnavailable: boolean;
  /** `keepPreviousData` is serving the PRE-change population. */
  isPlaceholderPage: boolean;
  isSessionsReadReady: boolean;
  /**
   * ISS-9897: the SUMMARY read has nothing settled for the scope on screen —
   * either nothing fetched yet, or the payload in hand is the previous cache
   * key's, held by `keepPreviousData`. Either way the metric row renders its
   * skeleton, exactly as the listing does.
   */
  isSummaryLoading: boolean;
  /** The summary read failed on a read that never landed. */
  isSummaryLoadingError: boolean;
  items: AgentSessionListItem[];
  listReadState: SessionsListReadState;
  listFilters: Parameters<typeof SessionsCsvExportMenuItem>[0]["filters"];
  markPageReset: () => void;
  onboardingAction: ReactNode;
  onPageSizeChange: (nextPageSize: number) => void;
  /** ISS-9555: which page the list read says it served. Absent on a legacy API. */
  pageInfo: AgentSessionListPageInfo | undefined;
  pageSize: number;
  projectFacetEnabled: boolean | undefined;
  replacePage: (nextPage: number) => void;
  resetView: () => void;
  /** PRD-721: the trimmed `?search=` term, or `""`. */
  search: string;
  selectedUserId: string | null;
  setColumnOrder: (nextOrder: string[]) => void;
  setColumnWidth: (columnId: string, widthPx: number) => void;
  setGroupBy: (next: SessionGroupBy) => void;
  setScrollContainer: (node: HTMLElement | null) => void;
  /** ISS-8335: replace the sort rules AFTER the primary. */
  setSecondarySorts: (next: readonly SessionSortRule[]) => void;
  setSort: (sortKey: SessionSortKey | null, sortDir: SessionSortDir) => void;
  /** ISS-8335: the persisted sort rules after `sortKey`/`sortDir`. */
  secondarySorts: readonly SessionSortRule[];
  sortDir: SessionSortDir;
  sortKey: SessionSortKey | null;
  /** The summary read's own state, for the period-over-period comparison. */
  summaryComparisonRead: SessionComparisonRead;
  summaryUsage: AgentSessionUsageSummary | undefined;
  toggleColumn: (id: string) => void;
  toggleSummaryCard: (id: string) => void;
  total: number;
  totalPages: number;
  visibleColumns: Set<string>;
};
