/**
 * ISS-8619 (PRD-699 §7.6): the ingest slice's LINKS/DERIVED phase — every
 * association and derived record this session implies once its own row exists,
 * split out of `upsert-session-slice.ts`.
 *
 * The lanes here share ONE locked authority read
 * (`resolveSessionRepositoryIdentity`), which is why they are one phase rather
 * than five call sites: the batch-wide project/slug preflight is safe to cache,
 * but eligibility authority is mutable and must not change between validation
 * and branch/PR-head materialization (ISS-5827 / COMMON-021), so the re-read
 * belongs inside this session's write transaction and every lane that consumes
 * it belongs after it.
 *
 * The PR lanes run in a fixed order the phase preserves: `PullRequestDetail`
 * materialization first, then the session→PR link replacement, because the
 * detail lane owns exact current/historical identity and the link lane needs its
 * completed map.
 */

import type { SyncedAgentSession } from "@repo/api/src/types/agent-session";
import { persistSessionBranchArtifactLinks } from "./artifact-links/branch-links";
import { persistSessionCommitRefs } from "./artifact-links/commit-links";
import { persistSessionPullRequestDetails } from "./artifact-links/pull-request-details";
import { persistSessionPullRequestArtifactLinks } from "./artifact-links/session-pr-link-persistence";
import {
  collectObservableRepositoryNames,
  resolveSessionRepositoryIdentity,
} from "./artifact-links/shared";
import { persistArtifactLinks } from "./artifact-links/slug-links";
import { toDate } from "./coercion";
import { persistSessionComponentUsage } from "./component-usage";
import { recordMonitoredActivityHoldStart } from "./monitored-activity-hold-ceiling";
import { persistMonitoredSessionActivity } from "./monitored-session-activity";
import type { MonitoredActivityOutcomeCounts } from "./monitored-session-activity-persistence";
import type { AgentSessionUpsertTx } from "./records";

export type SessionSliceLinks = {
  /** ISS-8125: index-key columns the component-usage rows had to bind. */
  indexKeyProjections: number;
  droppedOverflowUsageBuckets: readonly string[];
  monitoredActivityOutcomeCounts: MonitoredActivityOutcomeCounts;
  observedRepositoryFullNames: string[];
  retryRequired: boolean;
};

export async function persistSessionSliceLinks(
  tx: AgentSessionUpsertTx,
  input: Readonly<{
    artifactId: string;
    computeTargetId: string;
    organizationId: string;
    projectId: string | null;
    /**
     * ISS-11427: the STORED instant the cloud's monitored-activity hold on this
     * session began, or `null` when it is not held. The hold ceiling reads it,
     * and this phase writes the transitions back — see
     * {@link recordMonitoredActivityHoldStart}.
     */
    monitoredActivityHeldSince: Date | null;
    /** ISS-12031: the STORED split marker, see {@link recordMonitoredActivityHoldStart}. */
    monitoredActivityHoldPartRetained?: boolean | null;
    session: SyncedAgentSession;
    shouldUpdatePullRequestLinks: boolean;
    slugMap: Map<string, string>;
    syncTimestamp: Date;
  }>
): Promise<SessionSliceLinks> {
  const { artifactId, organizationId, projectId, session } = input;

  await persistArtifactLinks(
    tx,
    organizationId,
    artifactId,
    session.artifactRefs,
    input.slugMap,
    resolveArtifactContributionAt(session)
  );
  // Re-read and lock repository-default authority inside this session's write
  // transaction. The batch-wide project/slug preflight is safe to cache, but
  // eligibility authority is mutable and must not change between validation
  // and branch/PR-head materialization (ISS-5827 / COMMON-021).
  const repositoryIdentity = await resolveSessionRepositoryIdentity(
    tx,
    organizationId,
    [session]
  );
  await persistSessionBranchArtifactLinks(
    tx,
    organizationId,
    projectId,
    artifactId,
    session.artifactRefs,
    repositoryIdentity.authorities
  );
  const pullRequestLane = await persistSessionPullRequestDetails(
    tx,
    organizationId,
    projectId,
    artifactId,
    session.artifactRefs,
    repositoryIdentity.authorities,
    {
      shouldUpdatePullRequestLinks: input.shouldUpdatePullRequestLinks,
      providerLocksHeld: true,
    }
  );
  // The PullRequestDetail lane owns exact current/historical identity
  // materialization. Complete its map with already-verified rows for old
  // `prRefs`-only clients before replacing any session→PR metadata. The
  // per-lane freshness gate remains load-bearing: a stale or evidence-poor
  // replay must not wipe a newer canonical set — which is exactly why ISS-8604
  // opens it on the create arm, where there is no canonical set to wipe.
  if (input.shouldUpdatePullRequestLinks) {
    await persistSessionPullRequestArtifactLinks(tx, {
      organizationId,
      sessionArtifactId: artifactId,
      session,
      pullRequestDetails: pullRequestLane.details,
      providerLocksHeld: true,
    });
  }
  const monitoredActivity = await persistMonitoredSessionActivity(tx, {
    organizationId,
    projectId,
    sessionArtifactId: artifactId,
    artifactRefs: session.artifactRefs,
    pullRequestLane,
    repositoryIdentity,
    receivedAt: input.syncTimestamp,
    monitoredActivityHeldSince: input.monitoredActivityHeldSince,
  });
  await recordMonitoredActivityHoldStart(tx, {
    sessionArtifactId: artifactId,
    storedHeldSince: input.monitoredActivityHeldSince,
    storedPartRetained: input.monitoredActivityHoldPartRetained ?? null,
    holdRetained: monitoredActivity.holdRetained,
    chunk: session.chunk,
    receivedAt: input.syncTimestamp,
  });
  await persistSessionCommitRefs(
    tx,
    organizationId,
    artifactId,
    session.artifactRefs
  );
  // ISS-8125: the usage rows land in `idx_acsu_session_kind_key_branch`, a
  // FOUR-column UNIQUE btree whose three text columns arrive unbounded from the
  // wire. Its own projections join this slice's tally, as does ISS-8330's
  // dropped-bucket report — both are emitted once per batch, never per slice.
  const componentUsage = await persistSessionComponentUsage(
    tx,
    input.computeTargetId,
    artifactId,
    session
  );

  return {
    indexKeyProjections: componentUsage.indexKeyProjections,
    droppedOverflowUsageBuckets: componentUsage.droppedOverflowUsageBuckets,
    monitoredActivityOutcomeCounts: monitoredActivity.outcomeCounts,
    observedRepositoryFullNames: collectObservableRepositoryNames(
      [session],
      repositoryIdentity
    ),
    retryRequired: monitoredActivity.retryRequired,
  };
}

/**
 * ISS-7669: WHEN this session last contributed to the artifacts it references,
 * for the `lastContributedAt` stamp Related Sessions orders by.
 *
 * The session's OWN activity clock, never the ingest wall-clock. A desktop that
 * has been offline for a week syncs its whole backlog inside one real-time
 * window, so `new Date()` here would stamp a three-week-old contribution and a
 * yesterday one within seconds of each other and rank them by whichever the
 * batch happened to process last — "newest contribution" silently becoming
 * "most recently ingested". It also compounds on a long-lived chatty session,
 * whose every re-sync would re-inflate the stamp to now and permanently outrank
 * shorter, genuinely-more-recent work.
 *
 * The ladder mirrors `resolveIngestAwaitingInputSince`: `lastActivityAt` is the
 * genuine-activity value and the honest answer, `endedAt` covers a finished
 * session from a build that predates it, and `updatedAt` is required on the
 * payload so the ladder always resolves without a clock read. Each tier is
 * bounded by the session itself, so a backlog keeps its true relative order.
 *
 * A FALLBACK only. A closedloop artifact ref carries its own `observedAt`, and
 * `persistArtifactLinks` prefers it per edge; this covers the older builds and
 * partial payloads that omit it, where a session-grain bound is all there is.
 */
export function resolveArtifactContributionAt(
  session: SyncedAgentSession
): Date {
  return (
    toDate(session.lastActivityAt) ??
    toDate(session.endedAt) ??
    new Date(session.updatedAt)
  );
}
