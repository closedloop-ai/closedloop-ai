import {
  HOST_CAPABILITY,
  PRESENTATION,
  type SurfaceCapabilityKinds,
} from "../../../shared/lib/surface-capability-kind";
import type { SessionsListSurfaceV2Props } from "./sessions-list-surface-v2-props";

/**
 * ISS-9218 — for every optional prop of {@link SessionsListSurfaceV2Props},
 * whether a host may honestly say it cannot support it.
 *
 * Declared here rather than in the parity ledgers so a NEW optional prop forces
 * the decision at the type, not at whichever ledger happens to notice it: the
 * `satisfies` below fails `tsc` on a prop this map does not classify, and on an
 * entry the prop type no longer declares.
 *
 * Only the five `initial*` seeds are {@link PRESENTATION}. Each is a value the
 * surface substitutes a default for, and no host is unable to produce one —
 * which is exactly how `pageSizeOptions` shipped supplied on web and
 * `notSupported` on desktop with nothing red. ISS-9216 then retired that prop
 * along with `paginationReadout`: the page-size ladder and the range readout are
 * the surface's own, so neither is a host's to pass or to withhold.
 * Everything else is {@link HOST_CAPABILITY}: it wires the host's own data,
 * writes, persisted state, routes, read state, layout nodes, or query limits,
 * and a host that has none of those can say so.
 */
export const SESSIONS_LIST_SURFACE_V2_CAPABILITY_KINDS = {
  bulkActions: HOST_CAPABILITY,
  className: HOST_CAPABILITY,
  columnOrder: HOST_CAPABILITY,
  columnWidths: HOST_CAPABILITY,
  controlledView: HOST_CAPABILITY,
  customDateWindow: HOST_CAPABILITY,
  customFields: HOST_CAPABILITY,
  errorRecoveryAction: HOST_CAPABILITY,
  exportItem: HOST_CAPABILITY,
  favorites: HOST_CAPABILITY,
  getSessionHref: HOST_CAPABILITY,
  groupDrop: HOST_CAPABILITY,
  groupOptions: HOST_CAPABILITY,
  hasConnectedAgent: HOST_CAPABILITY,
  hasSessionsOutsideWindow: HOST_CAPABILITY,
  hiddenSummaryCards: HOST_CAPABILITY,
  includeProjectFilter: HOST_CAPABILITY,
  initialDateRange: PRESENTATION,
  initialFacets: PRESENTATION,
  initialGrouping: PRESENTATION,
  initialScopeUserId: PRESENTATION,
  initialSearch: PRESENTATION,
  inlineCreate: HOST_CAPABILITY,
  isError: HOST_CAPABILITY,
  isLoading: HOST_CAPABILITY,
  isPending: HOST_CAPABILITY,
  isPlaceholderPage: HOST_CAPABILITY,
  isSyncing: HOST_CAPABILITY,
  loadingLabel: HOST_CAPABILITY,
  maxOffset: HOST_CAPABILITY,
  maxSortRules: HOST_CAPABILITY,
  mode: HOST_CAPABILITY,
  onAddField: HOST_CAPABILITY,
  onColumnOrderChange: HOST_CAPABILITY,
  onColumnWidthChange: HOST_CAPABILITY,
  onCustomDateWindowChange: HOST_CAPABILITY,
  onPageSizeChange: HOST_CAPABILITY,
  onResetView: HOST_CAPABILITY,
  onRetry: HOST_CAPABILITY,
  onTimezoneModeChange: HOST_CAPABILITY,
  onToggleSummaryCard: HOST_CAPABILITY,
  onboardingAction: HOST_CAPABILITY,
  pageInfo: HOST_CAPABILITY,
  pageSize: HOST_CAPABILITY,
  renderIssues: HOST_CAPABILITY,
  renderPriority: HOST_CAPABILITY,
  renderProjects: HOST_CAPABILITY,
  renderTags: HOST_CAPABILITY,
  resolveOwnerName: HOST_CAPABILITY,
  resolveProjectName: HOST_CAPABILITY,
  savedViews: HOST_CAPABILITY,
  selection: HOST_CAPABILITY,
  stallPhase: HOST_CAPABILITY,
  summaryCards: HOST_CAPABILITY,
  tableScrollRef: HOST_CAPABILITY,
  timezoneMode: HOST_CAPABILITY,
  toolbarPrimary: HOST_CAPABILITY,
  toolbarTrailing: HOST_CAPABILITY,
} as const satisfies SurfaceCapabilityKinds<SessionsListSurfaceV2Props>;
