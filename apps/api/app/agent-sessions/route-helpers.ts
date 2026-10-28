import { AgentSessionViewerScope } from "@repo/api/src/types/agent-session";
import type { FeatureFlagIdentity } from "@/lib/feature-flag-identity";
import { SESSIONS_USAGE_TYPED_SQL_SHADOW_SERVER_FLAG } from "@/lib/feature-flags/server-feature-flags";
import { createMemoizedFeatureFlagGate } from "@/lib/memoized-feature-flag-gate";
import {
  authorizeTeamScopeRead,
  type TeamScopeAuthorization,
} from "@/lib/team-scope-policy";
import type { AgentSessionUsageQuery } from "./validators";

/**
 * Authorizes team-scoped agent-session reads before any session data query or
 * CSV stream starts. Legacy clients that send a bare `teamId` get the same
 * policy as explicit `viewerScope=team`.
 */
export function authorizeAgentSessionTeamScope(input: {
  organizationId: string;
  userId: string;
  clerkOrgId: string;
  clerkUserId: string;
  filters: AgentSessionUsageQuery;
}): Promise<TeamScopeAuthorization> {
  return authorizeTeamScopeRead({
    organizationId: input.organizationId,
    userId: input.userId,
    clerkOrgId: input.clerkOrgId,
    clerkUserId: input.clerkUserId,
    teamId: input.filters.teamId ?? undefined,
    requiresTeamScope:
      input.filters.viewerScope === AgentSessionViewerScope.Team,
  });
}

/**
 * ISS-4556: how long an UNAVAILABLE evaluation is honored before PostHog is asked
 * again — negative caching, so a sustained outage costs one blocking call per
 * viewer per window instead of one per read.
 *
 * Deliberately much shorter than any success TTL: the cached answer here is a
 * fallback, not an evaluation, so the cost of holding it too long is a viewer
 * stuck on a stale decision. Short enough that recovery is picked up within a
 * page load or two, long enough that the several reads of ONE load share an
 * answer rather than taking independent chances at a service that is failing.
 */
export const SESSIONS_FLAG_GATE_UNAVAILABLE_BACKOFF_MS = 5000;
/**
 * Hard entry cap, per the AGENTS.md bounded-growth rule for in-memory maps keyed
 * on external input. Evicts least-recently-refreshed first; a viewer evicted
 * early simply re-evaluates.
 */
export const SESSIONS_FLAG_GATE_MAX_ENTRIES = 5000;

/**
 * ISS-8554 — the TypedSQL shadow-comparison gate.
 *
 * This gate changes NOTHING a reader sees. It decides whether to run the
 * candidate summary alongside the live one and log the diff; the response is the
 * live path's either way. So a mid-request flip cannot change a number already
 * on screen, and an unanswered lookup folding closed simply means one reader
 * contributed no comparison.
 *
 * ISS-8554 Phase 3 (operator ruling 2026-10-09): ALSO gates the list-sort
 * shadow (`route.ts`'s list route, `session-list-sort-shadow.ts`) — reusing
 * this same gate rather than a second one, since both are the identical risk
 * class. This flag is already at 100% rollout in production, so the list-sort
 * shadow runs for every list request from the moment that code ships, with no
 * 0%-first window of its own.
 *
 * It is memoized anyway: the gate is read once per usage request, and a dark
 * rollout must not add a blocking PostHog call to an endpoint whose server time
 * is ~97% round trips.
 *
 * The TTL holds a decision only to bound lookup cost, not to keep a viewer's
 * numbers stable, so it is short: turning the shadow OFF during an incident
 * takes effect in seconds rather than a minute. Fastest safe removal matters
 * more here than decision stability, because this is the switch someone reaches
 * for when the extra load is the problem.
 */
export const USAGE_TYPED_SQL_SHADOW_DECISION_TTL_MS = 10_000;

const usageTypedSqlShadowGate = createMemoizedFeatureFlagGate({
  flag: SESSIONS_USAGE_TYPED_SQL_SHADOW_SERVER_FLAG,
  unavailableLogKey: "sessions_usage_typed_sql_shadow_flag_unavailable",
  ttlMs: USAGE_TYPED_SQL_SHADOW_DECISION_TTL_MS,
  unavailableBackoffMs: SESSIONS_FLAG_GATE_UNAVAILABLE_BACKOFF_MS,
  maxEntries: SESSIONS_FLAG_GATE_MAX_ENTRIES,
});

/**
 * Whether to run the ISS-8554 shadow comparison for this viewer.
 *
 * Fails CLOSED on an unanswered lookup, and that is uncontroversial here: a
 * closed shadow gate costs one missing diagnostic, where an open one costs a
 * duplicate read of the whole summary.
 */
export function resolveUsageTypedSqlShadow(
  identity: FeatureFlagIdentity,
  now: number = Date.now()
): Promise<boolean> {
  return usageTypedSqlShadowGate.resolve(identity, now);
}

/** Test seam: drop every memoized shadow decision. */
export function clearUsageTypedSqlShadowDecisions(): void {
  usageTypedSqlShadowGate.clear();
}
