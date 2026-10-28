import type {
  AgentSessionListItem,
  AgentSessionListResponse,
  AgentSessionUsageSummary,
} from "@repo/api/src/types/agent-session";
import type { AgentSessionRepositoryBreakdown } from "@repo/api/src/types/agent-session-usage-breakdown";
import { resolveCappedTotalPages } from "@repo/api/src/utils/math";
import {
  resolveSessionsListReadModel,
  SessionsListReadState,
  sessionsListReadModelFromState,
} from "@repo/app/agents/lib/sessions-list-read-state";
import type { SessionsDisplayState } from "./sessions-summary-cards-state";

/**
 * @file Pure data fold for the desktop Sessions view's render model, plus the
 * read-gate predicates that decide which auxiliary reads that fold is worth
 * paying for. Extracted from `SessionsView.tsx` (FEA-4299, extended by ISS-5273)
 * so both can be unit-tested without importing the component runtime and its
 * heavy `@repo/app` graph — see the desktop AGENTS.md "keep helpers in
 * lightweight modules" rule. No React, no hooks.
 *
 * The gates live beside the fold deliberately: each one exists because the fold
 * would discard the read's result, so a gate that drifted from the fold would
 * silently starve a surface of data it does render.
 */

/**
 * Default page size for the desktop Sessions table.
 *
 * ISS-8756: a DEFAULT now, not a fixed size. Desktop v1 keeps 25 fixed; v2
 * resolves the URL-owned choice and passes the size the read actually used.
 */
export const PAGE_SIZE = 25;

/**
 * Collapse the list + facet reads into the model the table renders.
 *
 * FEA-4299: usage OWNS the Repository filter facet. Both desktop usage paths
 * (the SQL `aggregateUsage` and the lightweight `buildUsageSummary` fold) now
 * carry a `byRepository` rollup keyed on the same `repositoryFullName` the rows
 * render, so the facet options match the rendered repos. The analytics
 * breakdown is only a legacy fallback for a usage summary that predates that
 * rollup and reports NO repositories — never an overwrite. Using `??` here would
 * let a successful analytics read clobber the usage-owned options, dropping
 * every Repository option (davetho).
 */
export function buildSessionsRenderModel({
  canReadSessions,
  displayState,
  maxOffset,
  isListError = false,
  isListLoading = false,
  isListLoadingError = false,
  isPlaceholderData = false,
  isPaginationTotalKnown = true,
  isPopulationComplete = true,
  sessionsData,
  facetUsage,
  repositoryBreakdown,
  pageSize = PAGE_SIZE,
}: {
  canReadSessions?: boolean;
  displayState: SessionsDisplayState;
  maxOffset?: number;
  isListError?: boolean;
  isListLoading?: boolean;
  isListLoadingError?: boolean;
  isPlaceholderData?: boolean;
  /** False when reconciliation cannot establish the total for page navigation. */
  isPaginationTotalKnown?: boolean;
  /** False when the rows are usable evidence but do not establish the full scope. */
  isPopulationComplete?: boolean;
  /** ISS-9692: the size the list read actually used. */
  pageSize?: number;
  sessionsData: AgentSessionListResponse | undefined;
  facetUsage: AgentSessionUsageSummary | undefined;
  repositoryBreakdown: AgentSessionRepositoryBreakdown[] | undefined;
}) {
  const sourceUnavailable = displayState === "unavailable";
  const sourceBlocksRows = displayState === "starting" || sourceUnavailable;
  const sessions = sourceBlocksRows ? [] : (sessionsData?.items ?? []);
  const resolvedReadModel = resolveSessionsListReadModel({
    canRead: canReadSessions ?? !sourceBlocksRows,
    hasData: sessionsData !== undefined && !sourceBlocksRows,
    isError: isListError,
    isLoading: isListLoading,
    isLoadingError: isListLoadingError,
    isPlaceholderData: !sourceBlocksRows && isPlaceholderData,
    isSyncing: displayState === "starting" || sourceUnavailable,
    knownTotal:
      sourceBlocksRows || !isPaginationTotalKnown
        ? undefined
        : sessionsData?.total,
    rowCount: sessions.length,
  });
  const readModel =
    !isPopulationComplete && sessionsData && !isPlaceholderData
      ? sessionsListReadModelFromState(
          SessionsListReadState.Partial,
          resolvedReadModel.totalRows
        )
      : resolvedReadModel;
  const total = readModel.totalRows ?? 0;
  const totalPages = resolveCappedTotalPages(total, pageSize, maxOffset);

  if (sourceBlocksRows) {
    return {
      hasRenderableData: false,
      knownTotal: readModel.totalRows,
      readState: readModel.state,
      sessions: [] as AgentSessionListItem[],
      total,
      totalPages,
      totalRowsKnown: readModel.hasKnownTotal,
      usage: undefined as AgentSessionUsageSummary | undefined,
    };
  }

  const usage = facetUsage
    ? {
        ...facetUsage,
        byRepository: needsAnalyticsRepositoryFallback(facetUsage)
          ? (repositoryBreakdown ?? facetUsage.byRepository)
          : facetUsage.byRepository,
      }
    : undefined;

  return {
    hasRenderableData: Boolean(sessionsData),
    knownTotal: readModel.totalRows,
    readState: readModel.state,
    sessions,
    total,
    totalPages,
    totalRowsKnown: readModel.hasKnownTotal,
    usage,
  };
}

/**
 * ISS-5273: is the analytics Repository breakdown actually consumed for this
 * usage summary?
 *
 * `buildSessionsRenderModel` above reads `repositoryBreakdown` in EXACTLY one
 * state — a usage summary that is present and reports no repositories (the
 * FEA-4299 legacy fallback). When usage is absent the whole `usage` model is
 * `undefined` and the breakdown is dropped; when usage owns repositories they
 * win outright. In both of those states the analytics value is discarded.
 *
 * SessionsView gates its `useAgentSessionAnalytics` read on this same predicate
 * so the desktop Sessions surface never pays for a read whose result it throws
 * away: on a real 4,285-session corpus that read (`syncSource.aggregateAnalytics`)
 * measured 27.1s and straddled the first page turn. Keeping the gate and the
 * consumer on ONE predicate is the point — a second, hand-copied condition at
 * the call site could drift and silently starve the facet of its fallback.
 *
 * This does not make the underlying aggregation cheaper; the per-cwd git/PATH
 * resolution behind it is ISS-5272.
 */
export function needsAnalyticsRepositoryFallback(
  facetUsage: AgentSessionUsageSummary | undefined
): boolean {
  return facetUsage !== undefined && facetUsage.byRepository.length === 0;
}

/**
 * Usage and analytics reads can be expensive on a large local store. Let the
 * list request settle first so the user sees rows before metric/facet work.
 */
export function canFetchSessionsAuxiliaryData({
  canReadSessions,
  hasSessionsData,
  isFetching,
  isPlaceholderData,
}: {
  canReadSessions: boolean;
  hasSessionsData: boolean;
  isFetching: boolean;
  isPlaceholderData: boolean;
}): boolean {
  if (!canReadSessions) {
    return false;
  }
  return hasSessionsData && !isFetching && !isPlaceholderData;
}
