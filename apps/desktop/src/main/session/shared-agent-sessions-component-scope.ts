import type { SharedAgentSessionsListRequest } from "../../shared/shared-agent-sessions-contract.js";
import type { AgentSessionSyncSource } from "../agent-sync/agent-session-sync-source.js";
import { MAX_LIST_IDS } from "./shared-agent-sessions-list-bounds.js";
import {
  type SanitizedQuery,
  sanitizeIds,
} from "./shared-agent-sessions-query.js";

export function explicitIdsFromRequest(
  request: SharedAgentSessionsListRequest
): string[] | null {
  if (!Object.hasOwn(request, "ids")) {
    return null;
  }
  const ids = (request as { ids?: unknown }).ids;
  return Array.isArray(ids) ? sanitizeIds(ids, { limit: MAX_LIST_IDS }) : [];
}

export async function resolveComponentSessionQuery(
  source: AgentSessionSyncSource,
  query: SanitizedQuery
): Promise<SanitizedQuery> {
  if (!query.componentSlug) {
    return query;
  }
  if (!source.resolveComponentSessionIds) {
    throw new Error("Component-scoped sessions unavailable");
  }
  return {
    ...query,
    componentSessionIds: await source.resolveComponentSessionIds(
      query.componentSlug
    ),
  };
}

export function withComponentScope<T>(value: T, query: SanitizedQuery): T {
  return query.componentSlug
    ? { ...value, componentScope: query.componentSlug }
    : value;
}
