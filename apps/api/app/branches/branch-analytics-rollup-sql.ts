import { LinkType } from "@repo/api/src/types/artifact";
import { SessionArtifactLinkKind } from "@repo/api/src/types/session-artifact-link";
import { ArtifactType, Prisma } from "@repo/database";
import { BRANCH_ANALYTICS_ROLLUP_RECEIVE_OVERLAP_MS } from "./branch-analytics-rollup-contract";
import { activeWriteBranchParticipationSql } from "./branch-contribution-sql";

/**
 * Branch analytics eligibility predicate for queries that alias token events as
 * `event` and their owning artifact as `artifact`.
 */
export function eligibleBranchSessionEventExistsSql(): Prisma.Sql {
  return Prisma.sql`EXISTS (
    SELECT 1
    FROM artifact_links al
    JOIN artifacts target
      ON target.id = al.target_id
      AND target.organization_id = artifact.organization_id
      AND target.type = ${ArtifactType.BRANCH}::"ArtifactType"
    WHERE al.organization_id = artifact.organization_id
      AND al.source_id = event.agent_session_id
      AND al.link_type = ${LinkType.RelatesTo}::"LinkType"
      AND ${branchAnalyticsSessionLinkKindSql()}
      AND ${activeWriteBranchParticipationSql()}
  )`;
}

/**
 * The events a Branch analytics rollup is allowed to aggregate as of `asOf`, for
 * queries that alias token events as `event`.
 *
 * Every query on this path must agree on it: `upsertBranchAnalyticsSessionRollups`
 * decides which events a rollup row SUMS, and the refresh queue decides when that
 * row is behind. If the two predicates drift, a session whose only excluded event
 * is counted by one side and not the other never converges — it is re-queued on
 * every pass, or never re-queued at all.
 *
 * The receive-time cutoff is part of the predicate, not a separate line each
 * caller remembers to add. The refresh queue counts source events through
 * `as_of` and only re-queues a materialized count that is too LOW, so a writer
 * that aggregated an event committed AFTER its own cutoff produces a count the
 * queue can never reconcile: the post-cutoff event is served under an older
 * `as_of`, and its surplus masks a pre-cutoff event that really is missing.
 */
export function branchSessionTokenEventInScopeSql(asOf: Date): Prisma.Sql {
  return Prisma.sql`(
    event.created_at <= ${asOf}
    AND event.input_tokens >= 0
    AND event.output_tokens >= 0
    AND event.cache_read_tokens >= 0
    AND event.cache_write_tokens >= 0
    AND (
      event.estimated_cost IS NULL
      OR event.estimated_cost >= 0
    )
  )`;
}

/**
 * The complement of the value terms in `branchSessionTokenEventInScopeSql`, for
 * queries that alias token events as `event`. A session holding one such row is
 * never materialized: the writer skips it, the refresh pass drops any rows it
 * wrote before the row arrived and keeps it out of the queue, and the read then
 * reports it missing so only the requests that include it fall back — to the
 * source read whose MIN columns surface the bad row.
 */
export function branchSessionTokenEventMalformedSql(): Prisma.Sql {
  return Prisma.sql`(
    event.input_tokens < 0
    OR event.output_tokens < 0
    OR event.cache_read_tokens < 0
    OR event.cache_write_tokens < 0
    OR (
      event.estimated_cost IS NOT NULL
      AND event.estimated_cost < 0
    )
  )`;
}

/**
 * ISS-10565: whether a session received a source event since it was last
 * materialized. Only such a session can have moved since then, so only its
 * history is re-read by the refresh pass; one range probe per session on the
 * `(agent_session_id, created_at)` index. An in-place edit to an event it
 * already holds is `branchSessionSyncedSinceMaterializedSql`'s to find.
 *
 * The overlap is measured from the later of the session's `as_of` and the
 * organization's reconciled-through cursor (`reconciled_through_at`). `as_of` alone
 * only moves when the session is rewritten, so a session that received an
 * event inside the overlap and then went quiet kept matching here on every
 * pass. The cursor is set only by a pass whose queue fit
 * its batch: such a pass rewrote every session that differed from its source
 * and confirmed every other one, so the only events such a session can be
 * missing are ones received after that pass.
 */
export function branchSessionReceivedSinceMaterializedSql(input: {
  organizationId: string;
  sessionId: Prisma.Sql;
  materializedAsOf: Prisma.Sql;
  asOf: Date;
}): Prisma.Sql {
  return Prisma.sql`EXISTS (
    SELECT 1
    FROM agent_session_token_events received
    WHERE received.agent_session_id = ${input.sessionId}
      AND received.created_at > GREATEST(
        ${input.materializedAsOf},
        (
          SELECT reconciled.reconciled_through_at
          FROM branch_analytics_rollup_states reconciled
          WHERE reconciled.organization_id = ${input.organizationId}::uuid
        )
      ) - ${BRANCH_ANALYTICS_ROLLUP_RECEIVE_OVERLAP_MS} * INTERVAL '1 millisecond'
      AND received.created_at <= ${input.asOf}
  )`;
}

/** Accepts the branch/session link-kind shapes produced by current and older ingest paths. */
export function branchAnalyticsSessionLinkKindSql(): Prisma.Sql {
  return Prisma.sql`(
    al.metadata->>'linkKind' = ${SessionArtifactLinkKind.SessionPr}
    OR al.metadata->>'linkKind' = ${SessionArtifactLinkKind.SessionBranch}
    OR al.metadata->'linkKinds' ? ${SessionArtifactLinkKind.SessionPrSet}
  )`;
}

/**
 * ISS-12779: whether a materialized session was synced since it was last
 * rewritten, for queries whose session row carries `last_synced_at`.
 *
 * The `token-events-single-in-place-writer` source gate
 * (`scripts/lint/rules/token-events-single-in-place-writer.ts`, ISS-12835)
 * keeps every in-place write to `agent_session_token_events` in
 * `token-event-persistence.ts`, whose writes run only inside a sync slice,
 * after the slice's `session_detail` upsert has stamped `last_synced_at`. So a
 * session this predicate does not match holds exactly the rows a full
 * re-aggregation would write. What a reprice or backfill of existing events
 * must do instead is that gate's contract. This replaces a re-aggregation of
 * every materialized session every six hours, which was most of the database's
 * block reads (ISS-12779).
 *
 * `last_synced_at` is stamped when the sync batch starts. Its slice commits
 * after the batch's pre-write reads plus at most the 20 s ingest work budget
 * or, for the first slice, one `AGENT_SESSION_UPSERT_TX_TIMEOUT_MS`
 * transaction (`ingest-work-budget.ts`), so the receive overlap covers that
 * gap the same way it covers `created_at`. Measured from the
 * session's own `as_of`, not the reconciled cursor: a matching session is
 * always rewritten, so its `as_of` advances on every visit and the match ends
 * once a rewrite lands more than the overlap after the stamp. Until then each
 * visit rewrites the session again, because no pass can tell whether the
 * sync committed before it read. That is the price of reusing the overlap as
 * the stamp-to-commit bound: one sync costs a rewrite per visit for the
 * length of the overlap.
 */
export function branchSessionSyncedSinceMaterializedSql(input: {
  lastSyncedAt: Prisma.Sql;
  materializedAsOf: Prisma.Sql;
}): Prisma.Sql {
  return Prisma.sql`(
    ${input.lastSyncedAt} > ${input.materializedAsOf}
      - ${BRANCH_ANALYTICS_ROLLUP_RECEIVE_OVERLAP_MS} * INTERVAL '1 millisecond'
  )`;
}
