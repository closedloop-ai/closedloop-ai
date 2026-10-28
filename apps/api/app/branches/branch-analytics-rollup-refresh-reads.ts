import { LinkType } from "@repo/api/src/types/artifact";
import { ArtifactType, Prisma } from "@repo/database";
import {
  BRANCH_ANALYTICS_ROLLUP_LEGACY_SOURCES,
  BRANCH_ANALYTICS_ROLLUP_SOURCE,
  type BranchAnalyticsRollupRefreshScanRow,
  type BranchAnalyticsRollupWriteClient,
} from "./branch-analytics-rollup-contract";
import {
  branchAnalyticsSessionLinkKindSql,
  branchSessionReceivedSinceMaterializedSql,
  branchSessionSyncedSinceMaterializedSql,
  branchSessionTokenEventInScopeSql,
  branchSessionTokenEventMalformedSql,
} from "./branch-analytics-rollup-sql";
import { activeWriteBranchParticipationSql } from "./branch-contribution-sql";

/**
 * Keep the watermark, malformed purge and ordered queue in one statement.
 * Preserve the bounded reads introduced by ISS-10565: newest-event index
 * probes supply the watermark, and only changed sessions have their history
 * scanned. LATERAL and OFFSET 0 keep PostgreSQL from widening these probes
 * into scans of every organization's token events.
 */
export async function readSourceWatermarkAndRefreshBatch(
  tx: BranchAnalyticsRollupWriteClient,
  organizationId: string,
  asOf: Date,
  sessionLimit: number
): Promise<BranchAnalyticsRollupRefreshScanRow> {
  const rows = await tx.$queryRaw<
    BranchAnalyticsRollupRefreshScanRow[]
  >(Prisma.sql`
WITH watermark_sessions AS MATERIALIZED (
        SELECT DISTINCT
          al.source_id AS id,
          source.type AS source_type,
          session.last_synced_at
        FROM artifact_links al
        JOIN artifacts source
          ON source.id = al.source_id
          AND source.organization_id = ${organizationId}::uuid
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
      materialized_sessions AS MATERIALIZED (
        SELECT
          rollup.session_artifact_id,
          MAX(rollup.as_of) AS as_of
        FROM watermark_sessions eligible
        JOIN branch_analytics_session_rollups rollup
          ON rollup.session_artifact_id = eligible.id
        WHERE rollup.organization_id = ${organizationId}::uuid
          AND rollup.source = ${BRANCH_ANALYTICS_ROLLUP_SOURCE}
        GROUP BY rollup.session_artifact_id
      ),
      session_watermarks AS MATERIALIZED (
        SELECT
          eligible.id AS agent_session_id,
          newest.event_created_at AS source_max_event_created_at,
          CASE
            WHEN materialized.session_artifact_id IS NULL
              OR ${branchSessionReceivedSinceMaterializedSql({
                organizationId,
                sessionId: Prisma.sql`eligible.id`,
                materializedAsOf: Prisma.sql`materialized.as_of`,
                asOf,
              })}
              OR ${branchSessionSyncedSinceMaterializedSql({
                lastSyncedAt: Prisma.sql`eligible.last_synced_at`,
                materializedAsOf: Prisma.sql`materialized.as_of`,
              })}
            THEN EXISTS (
              SELECT 1
              FROM agent_session_token_events event
              WHERE event.agent_session_id = eligible.id
                AND event.created_at <= ${asOf}
                AND ${branchSessionTokenEventMalformedSql()}
              OFFSET 0
            )
            ELSE FALSE
          END AS malformed
        FROM watermark_sessions eligible
        LEFT JOIN materialized_sessions materialized
          ON materialized.session_artifact_id = eligible.id
        CROSS JOIN LATERAL (
          SELECT event.event_created_at
          FROM agent_session_token_events event
          WHERE event.agent_session_id = eligible.id
            AND event.created_at <= ${asOf}
          ORDER BY event.event_created_at DESC
          LIMIT 1
        ) newest
      ),
      purged AS (
        DELETE FROM branch_analytics_session_rollups rollup
        USING session_watermarks session
        WHERE rollup.organization_id = ${organizationId}::uuid
          AND rollup.session_artifact_id = session.agent_session_id
          AND session.malformed
          AND rollup.source = ANY(ARRAY[
            ${Prisma.join([
              BRANCH_ANALYTICS_ROLLUP_SOURCE,
              ...BRANCH_ANALYTICS_ROLLUP_LEGACY_SOURCES,
            ])}
          ]::text[])
          AND rollup.as_of <= ${asOf}
        RETURNING 1
      ),
eligible_sessions AS MATERIALIZED (
      SELECT
        eligible.id AS "agentSessionId",
        eligible.last_synced_at
      FROM watermark_sessions eligible
      WHERE eligible.source_type = ${ArtifactType.SESSION}::"ArtifactType"
        AND EXISTS (
          SELECT 1
          FROM agent_session_token_events event
          WHERE event.agent_session_id = eligible.id
            AND ${branchSessionTokenEventInScopeSql(asOf)}
          OFFSET 0
        )
    ),
    materialized_buckets AS MATERIALIZED (
      SELECT
        rollup.session_artifact_id,
        MAX(rollup.as_of) AS as_of,
        MAX(rollup.source_max_event_created_at) AS source_max_event_created_at,
        -- A session linked to several branches carries one row per branch for
        -- the same bucket, so the count is taken once per bucket before it is
        -- summed per session.
        MAX(rollup.event_count)::bigint AS event_count
      FROM eligible_sessions eligible
      JOIN branch_analytics_session_rollups rollup
        ON rollup.session_artifact_id = eligible."agentSessionId"
      WHERE rollup.organization_id = ${organizationId}::uuid
        AND rollup.source = ${BRANCH_ANALYTICS_ROLLUP_SOURCE}
      GROUP BY rollup.session_artifact_id, rollup.bucket_start
    ),
    materialized_watermarks AS MATERIALIZED (
      SELECT
        bucket.session_artifact_id,
        MAX(bucket.as_of) AS as_of,
        MAX(bucket.source_max_event_created_at) AS source_max_event_created_at,
        SUM(bucket.event_count)::bigint AS event_count
      FROM materialized_buckets bucket
      GROUP BY bucket.session_artifact_id
    ),
    received_sessions AS MATERIALIZED (
      SELECT eligible."agentSessionId"
      FROM eligible_sessions eligible
      LEFT JOIN materialized_watermarks rollup
        ON rollup.session_artifact_id = eligible."agentSessionId"
      WHERE rollup.session_artifact_id IS NULL
        OR ${branchSessionReceivedSinceMaterializedSql({
          organizationId,
          sessionId: Prisma.sql`eligible."agentSessionId"`,
          materializedAsOf: Prisma.sql`rollup.as_of`,
          asOf,
        })}
        OR ${branchSessionSyncedSinceMaterializedSql({
          lastSyncedAt: Prisma.sql`eligible.last_synced_at`,
          materializedAsOf: Prisma.sql`rollup.as_of`,
        })}
    ),
    source_watermarks AS MATERIALIZED (
      SELECT history.*
      FROM received_sessions received
      CROSS JOIN LATERAL (
        SELECT
          event.agent_session_id AS session_artifact_id,
          MAX(event.event_created_at) FILTER (
            WHERE ${branchSessionTokenEventInScopeSql(asOf)}
          ) AS source_max_event_created_at,
          COUNT(*) FILTER (
            WHERE ${branchSessionTokenEventInScopeSql(asOf)}
          )::bigint AS source_event_count,
          BOOL_OR(${branchSessionTokenEventMalformedSql()}) AS malformed
        FROM agent_session_token_events event
        WHERE event.agent_session_id = received."agentSessionId"
          AND event.created_at <= ${asOf}
        GROUP BY event.agent_session_id
      ) history
    ),
refresh_batch AS MATERIALIZED (
    SELECT
      eligible."agentSessionId",
      rollup.as_of AS refresh_as_of,
      -- COALESCE, not a bare comparison: a NULL source watermark would make
      -- the OR evaluate NULL, and the contract types this field as a boolean.
      COALESCE(
        rollup.session_artifact_id IS NULL
        OR rollup.source_max_event_created_at < source.source_max_event_created_at,
        false
      ) AS "needsBackfill"
    FROM eligible_sessions eligible
    LEFT JOIN materialized_watermarks rollup
      ON rollup.session_artifact_id = eligible."agentSessionId"
    LEFT JOIN source_watermarks source
      ON source.session_artifact_id = eligible."agentSessionId"
    WHERE NOT COALESCE(source.malformed, false)
      AND (
        rollup.session_artifact_id IS NULL
        OR rollup.source_max_event_created_at < source.source_max_event_created_at
        OR rollup.event_count < source.source_event_count
        OR ${branchSessionSyncedSinceMaterializedSql({
          lastSyncedAt: Prisma.sql`eligible.last_synced_at`,
          materializedAsOf: Prisma.sql`rollup.as_of`,
        })}
      )
    ORDER BY
      "needsBackfill" DESC,
      rollup.as_of ASC NULLS FIRST,
      eligible."agentSessionId" ASC
    LIMIT ${sessionLimit}

)
SELECT
  MAX(source_max_event_created_at) FILTER (WHERE NOT malformed) AS "sourceWatermarkEventCreatedAt",
  COUNT(*) FILTER (WHERE malformed) AS "malformedSessionCount",
  (SELECT COUNT(*) FROM purged) AS "purgedRows",
  COALESCE((
    SELECT jsonb_agg(
      jsonb_build_object(
        'agentSessionId', batch."agentSessionId",
        'needsBackfill', batch."needsBackfill"
      ) ORDER BY batch."needsBackfill" DESC, batch.refresh_as_of ASC NULLS FIRST, batch."agentSessionId" ASC
    )
    FROM refresh_batch batch
  ), '[]'::jsonb) AS "sessionRefreshBatch"
FROM session_watermarks
  `);
  return (
    rows.at(0) ?? {
      sourceWatermarkEventCreatedAt: null,
      malformedSessionCount: 0n,
      purgedRows: 0n,
      sessionRefreshBatch: [],
    }
  );
}
