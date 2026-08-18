import { AgentSessionViewerScope } from "@repo/api/src/types/agent-session";
import { SESSIONS_DISPLAYED_STATUS_PARITY_FLAG_KEY } from "@repo/api/src/types/sessions-displayed-status-parity-flag";
import { isAgentMonitoringEnabledForUser } from "@/lib/agent-session-sync-feature";
import {
  evaluateFeatureFlagForAnyIdentity,
  type FeatureFlagIdentity,
  resolveDistinctIdsForIdentity,
} from "@/lib/feature-flag-identity";
import { authorizeTeamScopeRead } from "@/lib/team-scope-policy";
import type { AgentSessionUsageQuery } from "./validators";

export async function getAgentSessionViewerScope(input: {
  userId: string;
  clerkUserId: string;
}): Promise<{
  monitoringEnabled: boolean;
}> {
  const monitoringEnabled = await isAgentMonitoringEnabledForUser({
    userId: input.userId,
    clerkUserId: input.clerkUserId,
  });

  return {
    monitoringEnabled,
  };
}

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
}): Promise<boolean> {
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
 * How long one viewer's resolved `sessions-displayed-status-parity` decision is
 * reused. Long enough to cover the four reads a single Sessions page load
 * issues, short enough that flipping the PostHog rollout takes effect promptly.
 */
export const DISPLAYED_STATUS_PARITY_DECISION_TTL_MS = 60_000;
/**
 * ISS-4556: how long an UNAVAILABLE evaluation is honored before PostHog is asked
 * again — negative caching, so a sustained outage costs one blocking call per
 * viewer per window instead of one per read.
 *
 * Deliberately much shorter than the success TTL: the cached answer here is a
 * fallback, not an evaluation, so the cost of holding it too long is a viewer
 * stuck on a stale decision. Short enough that recovery is picked up within a
 * page load or two, long enough that the four reads of ONE load share an answer
 * rather than taking four independent chances at a service that is failing.
 */
export const DISPLAYED_STATUS_PARITY_UNAVAILABLE_BACKOFF_MS = 5000;
/**
 * Hard entry cap, per the AGENTS.md bounded-growth rule for in-memory maps keyed
 * on external input. Evicts least-recently-refreshed first; a viewer evicted
 * early simply re-evaluates.
 */
export const DISPLAYED_STATUS_PARITY_DECISION_MAX_ENTRIES = 5000;

type ParityDecision = {
  value: boolean;
  expiresAt: number;
};

const parityDecisions = new Map<string, ParityDecision>();

/**
 * ISS-4556 / ISS-4559: resolve the per-VIEWER `sessions-displayed-status-parity`
 * gate for a Sessions read. The result rides on `AgentSessionScope` so
 * `buildStatusFacetPredicate` stays synchronous.
 *
 * Every Sessions read that applies the Status facet must resolve it — the list,
 * the usage summary, the analytics fold, and the CSV export are ONE cohort for a
 * given filter set, so a partial rollout would let the table return a row under
 * Active that the summary cards above it do not count.
 *
 * Goes through the shared {@link evaluateFeatureFlagForAnyIdentity} seam rather
 * than calling PostHog directly, so it evaluates BOTH distinct-id namespaces
 * (`clerkUserId` then `userId`). A rollout targeted at Clerk ids — the usual
 * case — would never reach this gate if it only asked about the internal id, and
 * the cloud half would stay dark while the desktop Labs toggle flipped on: the
 * exact web/desktop skew this shared key exists to prevent.
 *
 * Those four routes are four independent requests, so asking PostHog once per
 * request made the gate per-REQUEST rather than per-viewer: a single timed-out
 * evaluation on `/agent-sessions/usage` painted summary cards built with the OFF
 * predicate above a table built with the ON one, differing by exactly the
 * awaiting-input rows, with nothing on screen saying why. Two things keep the
 * cohort coherent now:
 *   • the decision is resolved ONCE per viewer and reused for
 *     {@link DISPLAYED_STATUS_PARITY_DECISION_TTL_MS}, so the four reads of one
 *     page load share one answer rather than taking four independent chances,
 *     and
 *   • an UNAVAILABLE evaluation no longer silently reads as `false` — it holds
 *     the viewer's last known decision, so a transient outage cannot flip one
 *     read's cohort out from under its siblings.
 *
 * A cold cache with no prior decision still fails CLOSED (and emits the
 * `sessions_displayed_status_parity_flag_unavailable` warn), because an
 * unreachable flag service must not open a dark-launched feature. That is the
 * one residual window: `apps/api` is serverless, so two reads landing on two
 * instances that both have a cold cache can still disagree if PostHog is failing
 * for one of them. Closing that completely needs a shared decision store, which
 * is deliberately out of scope here — this narrows the exposure from every page
 * load to a cold instance during an actual outage, and always toward OFF, which
 * is the behavior every viewer already has.
 *
 * ISS-4556: the UNAVAILABLE branch only became reachable for a real outage once
 * `isFeatureFlagEnabledForDistinctId` stopped folding posthog-node's `undefined`
 * into `false`. Before that, a failing PostHog produced a definite `false` here,
 * which this memo would then cache for the full TTL — making the outage's wrong
 * answer STICKIER than the per-request evaluation it replaced. The unavailable
 * path now re-arms on {@link DISPLAYED_STATUS_PARITY_UNAVAILABLE_BACKOFF_MS}
 * rather than the full TTL, so a recovered PostHog is picked up promptly while a
 * sustained outage still costs one call per viewer per window.
 */
export async function resolveDisplayedStatusParity(
  identity: FeatureFlagIdentity,
  now: number = Date.now()
): Promise<boolean> {
  const cacheKey = buildParityCacheKey(identity);
  const cached = parityDecisions.get(cacheKey);
  if (cached && now < cached.expiresAt) {
    return cached.value;
  }

  const evaluated = await evaluateFeatureFlagForAnyIdentity(
    SESSIONS_DISPLAYED_STATUS_PARITY_FLAG_KEY,
    identity,
    "sessions_displayed_status_parity_flag_unavailable"
  );
  if (evaluated === null) {
    // Unavailable: hold the last known decision rather than silently reporting
    // OFF and splitting this viewer's page across two predicates. No prior
    // decision means fail closed.
    const fallback = cached?.value ?? false;
    // ISS-4556: re-arm on a SHORT backoff instead of returning without touching
    // the entry. Leaving `expiresAt` in the past meant every subsequent read
    // re-issued a blocking PostHog call — four per Sessions page load, against a
    // service already known to be failing — and gave the outage no negative
    // caching at all. Re-arming also keeps the fallback ALIVE for its own viewer,
    // which is the property the sweep below used to destroy.
    setParityDecision(
      cacheKey,
      fallback,
      now + DISPLAYED_STATUS_PARITY_UNAVAILABLE_BACKOFF_MS
    );
    return fallback;
  }

  setParityDecision(
    cacheKey,
    evaluated,
    now + DISPLAYED_STATUS_PARITY_DECISION_TTL_MS
  );
  return evaluated;
}

/** Test seam: drop every memoized gate decision. */
export function clearDisplayedStatusParityDecisions(): void {
  parityDecisions.clear();
}

/**
 * The memo key for a request principal.
 *
 * ISS-4556: `JSON.stringify` over the id LIST, not `join("|")`. A separator-joined
 * key is ambiguous — a principal whose id happens to contain the separator can
 * collide with a different principal's two-id key, and inheriting another
 * viewer's cached decision means a dark-launched feature served to someone
 * PostHog never enabled it for. Encoding the array makes the key injective at
 * zero cost.
 */
function buildParityCacheKey(identity: FeatureFlagIdentity): string {
  return JSON.stringify(resolveDistinctIdsForIdentity(identity));
}

/**
 * Write a decision, refreshing its RECENCY.
 *
 * ISS-4556: `Map.set` on an EXISTING key keeps that key's original insertion
 * slot, so iteration order is first-SEEN, not least-recently-used — and
 * {@link pruneOldestParityDecisions}, which evicts from the front, would
 * therefore drop the most ACTIVE viewers first (they were seen earliest and
 * refresh most often). Deleting before setting moves the key to the back on every
 * refresh, which is what makes the eviction order actually least-recently-used.
 *
 * ISS-4556: the cap is enforced HERE, at the single write point, rather than
 * after the caller's success path. The UNAVAILABLE branch also inserts an entry
 * per viewer, and it returned without pruning — leaving the map's ONLY bound
 * unenforced on exactly the path that runs when PostHog cannot answer. That is
 * steady state, not just an outage: with no `NEXT_PUBLIC_POSTHOG_KEY` the
 * analytics stub exposes no `isFeatureEnabled`, and posthog-node resolves
 * `undefined` for a flag key that does not exist in the project yet — both now
 * report UNAVAILABLE, so every viewer takes that branch for the whole window
 * before the flag is created, on a long-lived (Socket.IO) instance. Pruning on
 * write means no future branch can insert without the cap applying.
 */
function setParityDecision(
  key: string,
  value: boolean,
  expiresAt: number
): void {
  parityDecisions.delete(key);
  parityDecisions.set(key, { value, expiresAt });
  pruneOldestParityDecisions();
}

/**
 * ISS-4556: the cap is the ONLY bound on this map, deliberately.
 *
 * There was a companion expired-entry sweep, and it was removed rather than
 * fixed: it walked the WHOLE map, so any one viewer's successful evaluation
 * deleted every OTHER viewer's expired entry — destroying exactly the fallback
 * the UNAVAILABLE branch above promises ("hold the last known decision"), for
 * every viewer except the one doing the sweeping. An expired entry is not
 * garbage here; it is the outage answer. Growth stays bounded by this cap, which
 * is what the AGENTS.md rule actually asks for.
 */
function pruneOldestParityDecisions(): void {
  while (parityDecisions.size > DISPLAYED_STATUS_PARITY_DECISION_MAX_ENTRIES) {
    const oldestKey = parityDecisions.keys().next().value;
    if (oldestKey === undefined) {
      return;
    }
    parityDecisions.delete(oldestKey);
  }
}
