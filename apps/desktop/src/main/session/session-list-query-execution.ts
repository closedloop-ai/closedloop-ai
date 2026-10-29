import {
  ListQueryExecution,
  type ListQueryExecution as ListQueryExecutionValue,
  type ListQueryObservation,
} from "@repo/api/src/types/list-query-observability";
import { SESSIONS_SURFACE_DATE_WINDOW_FIELD } from "../../shared/session-date-window-contract.js";
import type { SharedAgentSessionsListRequest } from "../../shared/shared-agent-sessions-contract.js";
import type { AgentSessionSyncSource } from "../agent-sync/agent-session-sync-source.js";
import { supportsSessionCompactFilter } from "./session-compact-filter-capability.js";
import {
  canLoadCursorPageBeforeHydration,
  canPageBeforeLoading,
} from "./session-read-fast-paths.js";
import { canAnswerWithCount } from "./shared-agent-sessions-aggregate-query.js";
import {
  type SanitizedQuery,
  sanitizeQuery,
} from "./shared-agent-sessions-query.js";

/** Value-free observation callbacks for the Desktop list-query read boundary. */
export type SessionListQueryObserver = {
  onQueryExecution?: (execution: ListQueryExecutionValue) => void;
  onQueryObservation?: (observation: ListQueryObservation) => void;
};

/** Select the list execution path before any fallible source read begins. */
export async function sessionListQueryExecution(
  source: AgentSessionSyncSource,
  request: SharedAgentSessionsListRequest,
  query: SanitizedQuery = sanitizeQuery(
    request,
    SESSIONS_SURFACE_DATE_WINDOW_FIELD
  )
): Promise<ListQueryExecutionValue> {
  if (query.hasUnsupportedCloudFilter || query.scopeUnsatisfiable) {
    return ListQueryExecution.Unsupported;
  }
  if (
    source.countSessions &&
    canAnswerWithCount(request, query) &&
    (query.quality === "all" ||
      (await supportsSessionCompactFilter(source, "count")))
  ) {
    return ListQueryExecution.Count;
  }
  if (
    canLoadCursorPageBeforeHydration(source, request, query) &&
    ((query.quality === "all" && query.repositories.length === 0) ||
      (await supportsSessionCompactFilter(source, "cursor")))
  ) {
    return ListQueryExecution.CursorPage;
  }
  if (canPageBeforeLoading(source, request, query)) {
    return ListQueryExecution.PreHydrationPage;
  }
  return ListQueryExecution.HydratedFallback;
}

/** Select and publish execution before any fallible source read begins. */
export async function beginSessionListQuery(
  observer: SessionListQueryObserver,
  source: AgentSessionSyncSource,
  request: SharedAgentSessionsListRequest,
  query: SanitizedQuery
): Promise<ListQueryExecutionValue> {
  const execution = await sessionListQueryExecution(source, request, query);
  observer.onQueryExecution?.(execution);
  observer.onQueryObservation?.({ execution });
  if (query.scopeUnsatisfiable) {
    observeSessionListQueryPopulation(observer, 0);
  }
  return execution;
}

/** Publish the populations honestly known after the selected read completes. */
export function observeSessionListQueryPopulation(
  observer: SessionListQueryObserver,
  matchedCount: number,
  scannedCount?: number
): void {
  observer.onQueryObservation?.({
    matchedCount,
    ...(scannedCount === undefined ? {} : { scannedCount }),
  });
}

/** Publish the populations returned by a completed working-set read. */
export function observeSessionListWorkingSet(
  observer: SessionListQueryObserver,
  workingSet: { total: number; scannedCount?: number }
): void {
  observeSessionListQueryPopulation(
    observer,
    workingSet.total,
    workingSet.scannedCount
  );
}
