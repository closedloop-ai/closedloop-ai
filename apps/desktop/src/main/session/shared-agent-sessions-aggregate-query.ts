/**
 * The desktop local Sessions read's SQL-aggregate query shapes: whether a
 * count-only read can be answered by `COUNT(*)`, and the filter objects the
 * count and usage aggregates take.
 *
 * Moved out of `shared-agent-sessions-api.ts` unchanged (ISS-9555, continuing the
 * ISS-4771 shrink-only discipline that already took `shared-agent-sessions-list-bounds.ts`
 * out of it): the count-only fast path is where this change mints its `pageInfo`
 * echo, and an over-ceiling file must come back smaller than the edit found it.
 */

import type {
  SharedAgentSessionsListRequest,
  SharedAgentSessionsQuery,
} from "../../shared/shared-agent-sessions-contract.js";
import type {
  AgentSessionCountFilters,
  AgentSessionUsageAggregateFilters,
} from "../agent-sync/agent-session-read-model.js";
import { hasNoLocalFacetFilters } from "./session-read-fast-paths.js";
import type { SanitizedQuery } from "./shared-agent-sessions-query.js";

/**
 * FEA-4142: whether a count-only list read reduces to a SQLite
 * `COUNT(*)`. The count SQL (`source.countSessions`) covers status/statuses (via
 * the shared `buildUsageStatusPredicate`, identical to `matchesStatusFilter`),
 * ownership, the `startDate`/`endDate` window (on the read's
 * `dateWindowField`, threaded through `buildCountFilters`), and the `completedAfter`
 * completion bound — so those may be present. It CANNOT express a free-text
 * search, the repository facet, the in-memory-only local facets, an explicit-id
 * set, so those force the hydrated fold. Quality uses the shared SQLite
 * predicate over metadata, token, event and invocation signals.
 */
export function canAnswerWithCount(
  request: SharedAgentSessionsListRequest,
  query: SanitizedQuery
): boolean {
  return (
    query.countOnly &&
    !Object.hasOwn(request, "ids") &&
    query.search === null &&
    query.repositories.length === 0 &&
    hasNoLocalFacetFilters(query)
  );
}

/**
 * FEA-4142: the count filters for a count-only read — the shared aggregate
 * filters (status/ownership/started-window) plus the FEA-3009 completion bound
 * (`ended_at >= completedAfter`) serialized to the ISO string the SQL compares.
 */
export function buildCountFilters(
  query: SanitizedQuery
): AgentSessionCountFilters {
  return {
    ...buildAggregateFilters(query),
    ...(query.completedAfter
      ? { completedAfter: query.completedAfter.toISOString() }
      : {}),
  };
}

export function buildAggregateFilters(
  query: SanitizedQuery
): AgentSessionUsageAggregateFilters {
  return {
    ...(query.quality === "all" ? {} : { quality: query.quality }),
    ...(query.componentSessionIds === undefined
      ? {}
      : { componentSessionIds: query.componentSessionIds }),
    ...(query.harness ? { harness: query.harness } : {}),
    ...(query.harnesses.length > 0 ? { harnesses: query.harnesses } : {}),
    ...(query.models.length > 0 ? { models: query.models } : {}),
    ...(query.repositories.length > 0
      ? { repositories: query.repositories }
      : {}),
    ...(query.statuses.length > 0 ? { statuses: query.statuses } : {}),
    ...(query.statuses.length === 0 && query.status
      ? { status: query.status }
      : {}),
    ...(query.userIds.length > 0 ? { userIds: query.userIds } : {}),
    ...(query.userIds.length === 0 && query.userId
      ? { userId: query.userId }
      : {}),
    ...(query.startDate ? { startDate: query.startDate } : {}),
    ...(query.endDate ? { endDate: query.endDate } : {}),
    // ISS-5443: carry the read's window basis into the SQL aggregate so the
    // fast path and the hydrated fold bound on the same timestamp. Always set —
    // `sanitizeQuery` requires it — so the aggregate never falls back to a
    // default the JS fold did not use.
    dateWindowField: query.dateWindowField,
  };
}

/** Restrict grouped usage/analytics reads to filters their SQL can express. */
export function canUseAggregateSessionFilters(
  request: SharedAgentSessionsQuery,
  query: SanitizedQuery
): boolean {
  return (
    !Object.hasOwn(request, "ids") &&
    query.search === null &&
    // FEA-3009: completion-time bounds are not in the usage/analytics SQL.
    query.completedAfter === null &&
    hasNoLocalFacetFilters({ ...query, harnesses: [], models: [] })
  );
}

/** Older DB hosts must not claim compact support for these filter dimensions. */
export function needsVersionedCompactFilters(query: SanitizedQuery): boolean {
  return (
    query.quality !== "all" ||
    query.repositories.length > 0 ||
    query.harnesses.length > 0 ||
    query.models.length > 0
  );
}
