import { LinkType } from "@repo/api/src/types/artifact";
import { BranchParticipationKind } from "@repo/api/src/types/branch";
import { ArtifactType, Prisma, withDb } from "@repo/database";
import {
  BRANCH_ANALYTICS_ROLLUP_LEGACY_SOURCES,
  BRANCH_ANALYTICS_ROLLUP_SOURCE,
  BranchAnalyticsRollupState,
  type BranchAnalyticsRollupWriteClient,
  type UpsertBranchAnalyticsRollupStateInput,
} from "./branch-analytics-rollup-contract";
import { classifyBranchAnalyticsRollupFailure } from "./branch-analytics-rollup-failure";
import {
  branchAnalyticsSessionLinkKindSql,
  branchSessionTokenEventInScopeSql,
  branchSessionTokenEventMalformedSql,
} from "./branch-analytics-rollup-sql";
import { activeWriteBranchParticipationSql } from "./branch-contribution-sql";

export function deleteBranchAnalyticsSessionRollups(
  tx: BranchAnalyticsRollupWriteClient,
  organizationId: string,
  sessionArtifactIds: readonly string[],
  asOf: Date
): Promise<number> {
  return tx.$executeRaw(Prisma.sql`
    WITH requested_sessions AS MATERIALIZED (
      SELECT DISTINCT unnest(
        ARRAY[${Prisma.join(sessionArtifactIds)}]::uuid[]
      ) AS id
    )
    DELETE FROM branch_analytics_session_rollups rollup
    USING requested_sessions requested
    WHERE rollup.organization_id = ${organizationId}::uuid
      AND rollup.session_artifact_id = requested.id
      AND rollup.source = ANY(ARRAY[
        ${Prisma.join([
          BRANCH_ANALYTICS_ROLLUP_SOURCE,
          ...BRANCH_ANALYTICS_ROLLUP_LEGACY_SOURCES,
        ])}
      ]::text[])
      AND rollup.as_of <= ${asOf}
  `);
}

export async function upsertBranchAnalyticsSessionRollups(
  tx: BranchAnalyticsRollupWriteClient,
  organizationId: string,
  sessionArtifactIds: readonly string[],
  asOf: Date
): Promise<number> {
  const rows = await tx.$queryRaw<
    { upsertedRows: number | bigint }[]
  >(Prisma.sql`
    WITH requested_sessions AS MATERIALIZED (
      SELECT DISTINCT unnest(
        ARRAY[${Prisma.join(sessionArtifactIds)}]::uuid[]
      ) AS id
    ),
    -- ISS-10565: a session holding one malformed row gets NO rollup rows, so
    -- the read's completeness gate reports it missing and the request falls
    -- back to the source read whose MIN columns surface the bad row. Rows
    -- that merely excluded the event would serve a total that silently
    -- dropped it. Decided per SESSION here, once, rather than per event row.
    materializable_sessions AS MATERIALIZED (
      SELECT requested.id
      FROM requested_sessions requested
      WHERE NOT EXISTS (
        SELECT 1
        FROM agent_session_token_events event
        WHERE event.agent_session_id = requested.id
          AND event.created_at <= ${asOf}
          AND ${branchSessionTokenEventMalformedSql()}
      )
    ),
    event_buckets AS MATERIALIZED (
      SELECT
        event.agent_session_id AS session_artifact_id,
        -- ISS-9831: the PARTITION KEY, not a descriptor. This used to be
        -- MIN(event_created_at) under a GROUP BY on the session alone, which
        -- made every row a session lifetime total and left the read no choice
        -- but to refuse each of the ~34% of /branches requests that carry a
        -- date window. event_created_at is TIMESTAMP(3) with no time zone, so
        -- date_trunc here is UTC and does not depend on the session TimeZone.
        date_trunc('day', event.event_created_at) AS bucket_start,
        MAX(event.event_created_at) AS bucket_end,
        SUM(event.input_tokens) AS input_tokens,
        SUM(event.output_tokens) AS output_tokens,
        SUM(event.cache_read_tokens) AS cache_read_tokens,
        SUM(event.cache_write_tokens) AS cache_write_tokens,
        SUM(event.estimated_cost) AS estimated_cost,
        MIN(event.input_tokens) AS min_input_tokens,
        MIN(event.output_tokens) AS min_output_tokens,
        MIN(event.cache_read_tokens) AS min_cache_read_tokens,
        MIN(event.cache_write_tokens) AS min_cache_write_tokens,
        MIN(event.estimated_cost) AS min_estimated_cost,
        COUNT(event.estimated_cost)::int AS estimated_cost_event_count,
        COUNT(*)::int AS event_count,
        MIN(event.event_created_at) AS source_min_event_created_at,
        MAX(event.event_created_at) AS source_max_event_created_at
      FROM materializable_sessions requested
      JOIN agent_session_token_events event
        ON event.agent_session_id = requested.id
      JOIN session_detail session
        ON session.artifact_id = requested.id
      JOIN artifacts artifact
        ON artifact.id = session.artifact_id
      WHERE artifact.organization_id = ${organizationId}::uuid
        AND ${branchSessionTokenEventInScopeSql(asOf)}
      GROUP BY
        event.agent_session_id,
        date_trunc('day', event.event_created_at)
    ),
    session_branch_links AS MATERIALIZED (
      SELECT DISTINCT
        al.source_id AS session_artifact_id,
        al.target_id AS branch_artifact_id,
        COALESCE(
          al.branch_participation,
          ${BranchParticipationKind.Wrote}
        ) AS branch_participation,
        al.branch_participation_method
      FROM requested_sessions requested
      JOIN artifact_links al
        ON al.source_id = requested.id
      JOIN artifacts source
        ON source.id = al.source_id
        AND source.organization_id = ${organizationId}::uuid
        AND source.type = ${ArtifactType.SESSION}::"ArtifactType"
      JOIN session_detail session
        ON session.artifact_id = source.id
      JOIN artifacts target
        ON target.id = al.target_id
        AND target.organization_id = ${organizationId}::uuid
        AND target.type = ${ArtifactType.BRANCH}::"ArtifactType"
      WHERE al.organization_id = ${organizationId}::uuid
        AND al.link_type = ${LinkType.RelatesTo}::"LinkType"
        AND ${branchAnalyticsSessionLinkKindSql()}
        AND ${activeWriteBranchParticipationSql()}
    ),
    upserted AS (
      INSERT INTO branch_analytics_session_rollups (
        id,
        organization_id,
        branch_artifact_id,
        session_artifact_id,
        branch_participation,
        branch_participation_method,
        source,
        bucket_start,
        bucket_end,
        input_tokens,
        output_tokens,
        cache_read_tokens,
        cache_write_tokens,
        estimated_cost,
        min_input_tokens,
        min_output_tokens,
        min_cache_read_tokens,
        min_cache_write_tokens,
        min_estimated_cost,
        estimated_cost_event_count,
        event_count,
        source_min_event_created_at,
        source_max_event_created_at,
        as_of,
        created_at,
        updated_at
      )
      SELECT
        gen_random_uuid(),
        ${organizationId}::uuid,
        link.branch_artifact_id,
        bucket.session_artifact_id,
        link.branch_participation,
        link.branch_participation_method,
        ${BRANCH_ANALYTICS_ROLLUP_SOURCE},
        bucket.bucket_start,
        bucket.bucket_end,
        bucket.input_tokens,
        bucket.output_tokens,
        bucket.cache_read_tokens,
        bucket.cache_write_tokens,
        bucket.estimated_cost,
        bucket.min_input_tokens,
        bucket.min_output_tokens,
        bucket.min_cache_read_tokens,
        bucket.min_cache_write_tokens,
        bucket.min_estimated_cost,
        bucket.estimated_cost_event_count,
        bucket.event_count,
        bucket.source_min_event_created_at,
        bucket.source_max_event_created_at,
        ${asOf},
        ${asOf},
        ${asOf}
      FROM event_buckets bucket
      JOIN session_branch_links link
        ON link.session_artifact_id = bucket.session_artifact_id
      ON CONFLICT (
        organization_id,
        branch_artifact_id,
        session_artifact_id,
        branch_participation,
        source,
        bucket_start
      )
      DO UPDATE SET
        branch_participation_method = EXCLUDED.branch_participation_method,
        bucket_end = EXCLUDED.bucket_end,
        input_tokens = EXCLUDED.input_tokens,
        output_tokens = EXCLUDED.output_tokens,
        cache_read_tokens = EXCLUDED.cache_read_tokens,
        cache_write_tokens = EXCLUDED.cache_write_tokens,
        estimated_cost = EXCLUDED.estimated_cost,
        min_input_tokens = EXCLUDED.min_input_tokens,
        min_output_tokens = EXCLUDED.min_output_tokens,
        min_cache_read_tokens = EXCLUDED.min_cache_read_tokens,
        min_cache_write_tokens = EXCLUDED.min_cache_write_tokens,
        min_estimated_cost = EXCLUDED.min_estimated_cost,
        estimated_cost_event_count = EXCLUDED.estimated_cost_event_count,
        event_count = EXCLUDED.event_count,
        source_min_event_created_at = EXCLUDED.source_min_event_created_at,
        source_max_event_created_at = EXCLUDED.source_max_event_created_at,
        as_of = EXCLUDED.as_of,
        updated_at = EXCLUDED.updated_at
      WHERE branch_analytics_session_rollups.as_of <= EXCLUDED.as_of
      RETURNING 1
    )
    SELECT COUNT(*) AS "upsertedRows"
    FROM upserted
  `);
  return numberFromCount(rows.at(0)?.upsertedRows);
}

export async function upsertBranchAnalyticsRollupState(
  tx: BranchAnalyticsRollupWriteClient,
  input: UpsertBranchAnalyticsRollupStateInput
): Promise<void> {
  await tx.$executeRaw(Prisma.sql`
    INSERT INTO branch_analytics_rollup_states (
      organization_id,
      state,
      source_watermark_event_created_at,
      materialized_through_event_created_at,
      as_of,
      lag_seconds,
      backfill_completed_at,
      last_backfill_started_at,
      last_backfill_completed_at,
      reconciled_through_at,
      last_error_at,
      last_error_code,
      created_at,
      updated_at
    )
    VALUES (
      ${input.organizationId}::uuid,
      ${input.state},
      ${input.sourceWatermarkEventCreatedAt},
      ${input.materializedThroughEventCreatedAt},
      ${input.asOf},
      ${input.lagSeconds},
      ${input.backfillCompletedAt},
      ${input.asOf},
      ${input.backfillCompletedAt},
      ${input.receivedReconciledThrough},
      NULL,
      NULL,
      ${input.asOf},
      ${input.asOf}
    )
    ON CONFLICT (organization_id)
    DO UPDATE SET
      state = EXCLUDED.state,
      source_watermark_event_created_at = EXCLUDED.source_watermark_event_created_at,
      materialized_through_event_created_at = EXCLUDED.materialized_through_event_created_at,
      as_of = EXCLUDED.as_of,
      lag_seconds = EXCLUDED.lag_seconds,
      backfill_completed_at = EXCLUDED.backfill_completed_at,
      last_backfill_started_at = EXCLUDED.last_backfill_started_at,
      last_backfill_completed_at = EXCLUDED.last_backfill_completed_at,
      reconciled_through_at = COALESCE(
        EXCLUDED.reconciled_through_at,
        branch_analytics_rollup_states.reconciled_through_at
      ),
      last_error_at = NULL,
      last_error_code = NULL,
      updated_at = EXCLUDED.updated_at
    WHERE branch_analytics_rollup_states.as_of IS NULL
      OR branch_analytics_rollup_states.as_of <= EXCLUDED.as_of
  `);
}

export async function recordBranchAnalyticsRollupFailure(
  organizationId: string,
  error: unknown,
  now: Date
): Promise<void> {
  const category = classifyBranchAnalyticsRollupFailure(error);
  await withDb((db) =>
    db.$executeRaw(Prisma.sql`
      INSERT INTO branch_analytics_rollup_states (
        organization_id,
        state,
        as_of,
        last_error_at,
        last_error_code,
        created_at,
        updated_at
      )
      VALUES (
        ${organizationId}::uuid,
        ${BranchAnalyticsRollupState.Error},
        ${now},
        ${now},
        ${category},
        ${now},
        ${now}
      )
      -- ISS-10565: the failed pass rolled back and wrote nothing, so the stored
      -- state still describes the rows a read would serve. Overwriting it with
      -- error refused every read of a rollup that was intact; the stored as_of
      -- now ages out through the read's staleness ceiling if failures persist.
      -- Both clocks gate the write, so a failure that finishes after a newer
      -- one cannot rewind last_error_at, which orders the due sweep.
      ON CONFLICT (organization_id)
      DO UPDATE SET
        last_error_at = EXCLUDED.last_error_at,
        last_error_code = EXCLUDED.last_error_code,
        updated_at = EXCLUDED.updated_at
      WHERE (
          branch_analytics_rollup_states.as_of IS NULL
          OR branch_analytics_rollup_states.as_of <= EXCLUDED.as_of
        )
        AND (
          branch_analytics_rollup_states.last_error_at IS NULL
          OR branch_analytics_rollup_states.last_error_at <= EXCLUDED.last_error_at
        )
    `)
  );
}

function numberFromCount(value: number | bigint | undefined): number {
  if (typeof value === "bigint") {
    if (value <= BigInt(Number.MAX_SAFE_INTEGER)) {
      return Number(value);
    }
    throw new Error("branch_analytics_rollup_count_unsafe");
  }
  return value ?? 0;
}
