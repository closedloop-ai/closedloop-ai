import type {
  AgentSessionListItem,
  AgentSessionListResponse,
  AgentSessionUsageSummary,
} from "@repo/api/src/types/agent-session";
import type { AgentSessionRepositoryBreakdown } from "@repo/api/src/types/agent-session-usage-breakdown";
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

/** Fixed page size for the desktop Sessions table (mirrors the list request). */
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
 * let a successful analytics read (or its empty-array catch fallback) clobber
 * the usage-owned options, dropping every Repository option (shafty023).
 */
export function buildSessionsRenderModel({
  displayState,
  sessionsData,
  facetUsage,
  repositoryBreakdown,
}: {
  displayState: SessionsDisplayState;
  sessionsData: AgentSessionListResponse | undefined;
  facetUsage: AgentSessionUsageSummary | undefined;
  repositoryBreakdown: AgentSessionRepositoryBreakdown[] | undefined;
}) {
  if (displayState === "starting" || displayState === "unavailable") {
    return {
      hasRenderableData: false,
      sessions: [] as AgentSessionListItem[],
      total: 0,
      totalPages: 1,
      usage: undefined as AgentSessionUsageSummary | undefined,
    };
  }

  const sessions = sessionsData?.items ?? [];
  const total = sessionsData?.total ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

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
    sessions,
    total,
    totalPages,
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
