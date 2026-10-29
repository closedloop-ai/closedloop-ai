import { Prisma } from "@repo/database";
import {
  BRANCH_ANALYTICS_ROLLUP_SOURCE,
  type BranchAnalyticsRollupIncompleteSessionRow,
  type BranchAnalyticsRollupReadClient,
} from "./branch-analytics-rollup-contract";
import { eligibleBranchSessionEventExistsSql } from "./branch-analytics-rollup-sql";

/**
 * The read's completeness gate: is any requested session missing from the
 * rollup, or behind its own source?
 *
 * ISS-10565 — this compares WATERMARKS, one index probe per session on each
 * side, and its cost must stay a function of the session count. It used to
 * recount every source event of every requested session, which made a SERVED
 * rollup read cost more than the source scan the rollup exists to replace:
 * measured in production on 869 sessions, 11,269 ms of gate against 32 ms of
 * rollup, and 14 ms for this statement.
 *
 * What a watermark cannot see is the refresh pass's to find, off the request
 * path: an event ingested BELOW its session's materialized watermark is the
 * count-drift term in `readSourceWatermarkAndRefreshBatch`, and a session
 * holding a malformed source row is never materialized (`readSourceWatermarkAndRefreshBatch`
 * lists it, the writer skips it), so this gate reports it missing and only the
 * requests that include it fall back. That is why the source side here is the
 * newest RECEIVED event rather than the newest in-scope one: a session whose
 * every event is malformed has no in-scope event, and a lateral that found
 * nothing would drop the session from this result and let the read serve it as
 * zero usage with no signal. Received by `as_of` is the only bound.
 *
 * The lateral is named `event` on purpose: `eligibleBranchSessionEventExistsSql`
 * binds to that alias, and binding it to one row per session is what evaluates
 * eligibility per SESSION. Evaluated per event row it was 824,685 probes for
 * 869 answers.
 *
 * ONE bind parameter carries the whole id set (B1, tamsinb review on #8791).
 * `ARRAY[${Prisma.join(ids)}]` spends a parameter per session, and ISS-12346
 * removed the 1,000-session cap above this: past the protocol's 65,535-parameter
 * limit the statement fails to bind, and a gate that cannot run takes the whole
 * analytics read with it. `costSlicesFromEventsSql` already passes its ids this
 * way.
 */
export function selectIncompleteMaterializedSessions(
  db: BranchAnalyticsRollupReadClient,
  input: {
    organizationId: string;
    sessionIds: readonly string[];
    asOf: Date;
  }
): Promise<BranchAnalyticsRollupIncompleteSessionRow[]> {
  return db.$queryRaw<BranchAnalyticsRollupIncompleteSessionRow[]>(Prisma.sql`
    WITH requested_sessions AS MATERIALIZED (
      SELECT DISTINCT unnest(${[...input.sessionIds]}::uuid[]) AS id
    )
    SELECT requested.id AS "agentSessionId"
    FROM requested_sessions requested
    JOIN session_detail session
      ON session.artifact_id = requested.id
    JOIN artifacts artifact
      ON artifact.id = session.artifact_id
    CROSS JOIN LATERAL (
      SELECT
        event.agent_session_id,
        event.event_created_at
      FROM agent_session_token_events event
      WHERE event.agent_session_id = requested.id
        AND event.created_at <= ${input.asOf}
      ORDER BY event.event_created_at DESC
      LIMIT 1
    ) event
    CROSS JOIN LATERAL (
      SELECT MAX(rollup.source_max_event_created_at) AS source_max_event_created_at
      FROM branch_analytics_session_rollups rollup
      WHERE rollup.organization_id = ${input.organizationId}::uuid
        AND rollup.session_artifact_id = requested.id
        AND rollup.source = ${BRANCH_ANALYTICS_ROLLUP_SOURCE}
    ) materialized_watermark
    WHERE artifact.organization_id = ${input.organizationId}::uuid
      AND ${eligibleBranchSessionEventExistsSql()}
      AND (
        materialized_watermark.source_max_event_created_at IS NULL
        OR materialized_watermark.source_max_event_created_at < event.event_created_at
      )
    LIMIT 1
  `);
}
