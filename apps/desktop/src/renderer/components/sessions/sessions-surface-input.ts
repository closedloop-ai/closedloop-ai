import type { SortDirection } from "@closedloop-ai/design-system/components/ui/sortable-column-header";
import type { ListEmptyStateSignals } from "@repo/api/src/list-empty-state";
import type {
  AgentSessionListItem,
  AgentSessionUsageSummary,
  SessionLinkedArtifact,
} from "@repo/api/src/types/agent-session";
import type { AgentSessionListPageInfo } from "@repo/api/src/types/agent-session-list-contract";
import type { SessionsCustomFieldsController } from "@repo/app/agents/components/sessions/sessions-list-custom-fields";
import type { SessionsFavoriteController } from "@repo/app/agents/components/sessions/sessions-list-interactions";
import type { SessionsSummaryCardsPassthrough } from "@repo/app/agents/components/sessions/sessions-list-summary-band";
import type { SessionCustomDateWindow } from "@repo/app/agents/lib/session-custom-date-window";
import type { SessionFacetFilters } from "@repo/app/agents/lib/session-filter-adapter";
import type { SessionGroupBy } from "@repo/app/agents/lib/session-grouping";
import type { SessionsSeamCellRenderer } from "@repo/app/agents/lib/session-list-row";
import type {
  SessionSortDir,
  SessionSortKey,
  SessionSortRule,
} from "@repo/app/agents/lib/session-sort-group";
import type { SessionsListReadState } from "@repo/app/agents/lib/sessions-list-read-state";
import type { TimezoneMode } from "@repo/app/shared/lib/date-window-timezone-mode";
import type { DateRange } from "@repo/app/shared/lib/format-utils";
import type { LoadingStallPhase } from "@repo/app/shared/lib/loading-stall-phase";
import type { ProfilerOnRenderCallback, ReactNode } from "react";

/**
 * ISS-8909 — everything the desktop Sessions listing reads, derived once by
 * `SessionsView` and handed to the branch that renders it.
 *
 * The twin of the web page's `sessions-surface-input.ts`, and the same reason
 * for existing: the read, the saved view, the URL writers and the error
 * classification belong to the SURFACE, not to a table stack, so deriving them
 * per branch would be two reads of one list and two answers to every question
 * about it. Anything only one branch needs is derived inside that branch.
 *
 * One branch consumes it: `sessions-v2-view.tsx`, the only desktop Sessions
 * surface since ISS-8909 retired the v1 stack. Anything only that branch needs
 * — the row mapping, the controlled view — is derived inside it.
 */
export type DesktopSessionsSurfaceInput = {
  /** FEA-3722: the selected window as a lookback, or null for all-time. */
  coachingLookbackDays: number | null;
  columnOrder: readonly string[] | undefined;
  /**
   * ISS-12691: the shared per-user favorite star, cloud mode only — see
   * `useSessionsFavoritesController`. Same gate as {@link customFields}: a
   * local-mode session id is not an artifact id, so the controller is
   * `undefined` there.
   */
  favorites: SessionsFavoriteController | undefined;
  columnWidths: Readonly<Record<string, number>>;
  customDateWindow: SessionCustomDateWindow | null;
  /**
   * ISS-12455: the custom-field column definitions and value-write seam, cloud
   * mode only — see `useDesktopSessionsCustomFieldsController`.
   */
  customFields: SessionsCustomFieldsController | undefined;
  dateRange: DateRange;
  /** FEA-4181: the filtered-vs-genuinely-empty split, derived once. */
  emptySignals: ListEmptyStateSignals;
  errorRecoveryAction: ReactNode;
  facetFilters: SessionFacetFilters;
  getIssueHref:
    | ((artifact: SessionLinkedArtifact) => string | null)
    | undefined;
  groupBy: SessionGroupBy;
  handleClearFilters: () => void;
  handleCustomDateWindowChange:
    | ((next: SessionCustomDateWindow | null) => void)
    | undefined;
  handleDateRangeChange: (next: DateRange) => void;
  /**
   * ISS-9619 — the day boundary this shell's window means, and its writer. Read
   * ONCE in `SessionsView` and handed to whichever branch renders, so the two
   * rollout branches cannot window their rows differently.
   */
  timezoneMode: TimezoneMode;
  handleTimezoneModeChange: ((next: TimezoneMode) => void) | undefined;
  handleFiltersChange: (next: SessionFacetFilters) => void;
  handleRetry: () => void;
  /**
   * ISS-9107: the v2 surface reports every scope axis it moved as ONE settled
   * view, so its window, facets and search term reach the URL in a single write.
   * @see SessionsListUrlWriters.handleScopeChange for why that matters.
   */
  handleScopeChange: (delta: {
    /** ISS-9107: drop the explicit `?from=`/`?to=` window in this same write. */
    clearWindow: boolean;
    dateRange: DateRange | null;
    facets: SessionFacetFilters;
    /** PRD-721: the new `?search=` term (`""` clears it), or `null` unmoved. */
    search: string | null;
  }) => void;
  handleSort: (column: string, direction: SortDirection) => void;
  hasConnectedAgent: boolean | undefined;
  hasRenderableData: boolean;
  /** ISS-11913 @see SessionsListSurfaceV2Props.hasSessionsOutsideWindow */
  hasSessionsOutsideWindow: boolean | undefined;
  hiddenSummaryCards: ReadonlySet<string>;
  /** FEA-4217: the set BOTH the strip and the View menu read. */
  hiddenSummaryCardIds: ReadonlySet<string> | undefined;
  isAuthenticated: boolean;
  isListPlaceholderPage: boolean;
  listReadState: SessionsListReadState;
  /** The local source is coming up rather than having failed (FEA-4181). */
  isSessionsSyncing: boolean;
  /** The summary strip's own loading gate, independent of the table's. */
  isSummaryLoading: boolean;
  isSessionsTableLoading: boolean;
  items: AgentSessionListItem[];
  onColumnOrderChange: (nextOrder: string[]) => void;
  onColumnWidthChange: (columnId: string, widthPx: number) => void;
  /** FEA-1998: the render-commit `Profiler` callback for the sessions list. */
  onRenderCommit: ProfilerOnRenderCallback;
  /**
   * ISS-8756: the URL-owned rows-per-page handler. Omitted only when the v2
   * control must be withheld, so a handler's presence still means the surface
   * can drive a real read.
   */
  onPageSizeChange?: (pageSize: number) => void;
  page: number;
  /**
   * ISS-9555: which page the list read says it served. Cloud mode gets it from
   * the `apps/api` route and local mode from the SQLite producer, both minting
   * the same contract; absent on an older build of either.
   */
  pageInfo: AgentSessionListPageInfo | undefined;
  pageSize: number;
  /**
   * ISS-12455: the Tags cell, cloud mode only — tags are an org vocabulary a
   * signed-out local session has no context for. @see customFields
   */
  renderTags: SessionsSeamCellRenderer | undefined;
  resetView: () => void;
  sessionsExportItem: ReactNode;
  setGroupBy: (next: SessionGroupBy) => void;
  setPage: (next: number) => void;
  showLinkedEntityColumns: boolean;
  /**
   * ISS-10332: whether the ACTIVE data source can write a priority, which is
   * the whole answer to mounting the editor — the cloud HTTP source can, and
   * the local store can since PLN-2086 Milestone 3 supplied its own write.
   */
  showPriorityColumn: boolean;
  /** The sidebar-written `?search=` term, or undefined when nothing is searched. */
  search: string | undefined;
  /** ISS-8335: the sort rules AFTER the primary, which only the v2 toolbar stacks. */
  secondarySorts: readonly SessionSortRule[];
  setSecondarySorts: (next: readonly SessionSortRule[]) => void;
  setSort: (sortKey: SessionSortKey | null, sortDir: SessionSortDir) => void;
  sortDir: SessionSortDir;
  sortKey: SessionSortKey | null;
  stallPhase: LoadingStallPhase;
  summaryCards: DesktopSessionsSummaryCardsInput;
  /**
   * The RAW facet usage the summary cards aggregate. Distinct from `usage`
   * below, which is the render model's copy with the FEA-4299 analytics
   * repository fallback folded in for the Repository facet's options.
   */
  summaryUsage: AgentSessionUsageSummary | undefined;
  /**
   * The v1 body's holding copy — "Getting your sessions ready", the
   * search-specific wording — or `undefined` once rows can render.
   */
  tableLoadingLabel: string | undefined;
  toggleColumn: (id: string) => void;
  toggleSummaryCard: (cardId: string) => void;
  maxOffset?: number;
  total: number;
  totalPages: number;
  usage: AgentSessionUsageSummary | undefined;
  visibleColumns: Set<string>;
};

/**
 * The desktop summary strip's prop set, DERIVED from the canonical
 * `SessionsSummaryCardsPassthrough` rather than restated key by key.
 *
 * Derived because a hand-written copy cannot do the job this type exists for.
 * Its whole purpose is that the local-mode set (`localUsage`,
 * `importInProgress`, `couldNotImportLabel`, `isLocalError`,
 * `alwaysAvailableLoading`) reaches every branch that renders the strip — and a
 * literal list silently stops covering the next prop `SessionsSummaryCards`
 * grows. `sessions-list-surface-v2-props.ts` records that exact loss happening
 * once already (ISS-7355: a host "silently LOST five shipped behaviours"),
 * which is why the canonical type is an `Omit` over the component's own props.
 *
 * The four keys removed here are the ones a desktop caller must NOT supply:
 * `githubConnect`/`githubConnected` are resolved by
 * `SessionsSummaryCardsWithGitHubConnect` itself, and `authenticated`/
 * `wrapBelow` are branch-level layout/auth decisions passed as their own
 * arguments beside this bag.
 */
export type DesktopSessionsSummaryCardsInput = Omit<
  SessionsSummaryCardsPassthrough,
  "authenticated" | "githubConnect" | "githubConnected" | "wrapBelow"
>;
