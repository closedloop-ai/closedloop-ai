import { BranchActivityEvidenceCompleteness } from "@repo/api/src/types/branch-activity";
import {
  ArtifactRefTargetKind,
  MAX_SYNCED_ARTIFACT_REFS_PRODUCER,
} from "@repo/api/src/types/session-artifact-link";
import { MonitoredSessionActivityEventKind } from "@repo/api/src/types/session-monitored-activity";
import {
  BRANCH_ACTIVITY_SCOPE_BATCH_SIZE,
  normalizedRepositorySql,
  privateCarrierMetadataPredicateSql,
  regularCarrierEvidencePredicateSql,
  safeJsonSql,
  timestampEpochMillisecondsSql,
  validMetadataSql,
} from "./branch-activity-sql.js";
import {
  isoTimestampValidSql,
  jsTrimSql,
} from "./branch-activity-timestamp-sql.js";
import { MONITORED_ACTIVITY_ONLY_METADATA_KEY } from "./synced-monitored-session-activity.js";

/**
 * Optimistic activity read for the common complete regular-Branch carrier shape.
 * Any evidence family whose degraded semantics are not represented here causes
 * the caller to fall back to the full canonical reconciliation query.
 */
export const BRANCH_ACTIVITY_FAST_PATH_SQL = `WITH RECURSIVE requested_scope_batches AS (
    SELECT batch.value AS batch_json
    FROM json_each(?) batch
    WHERE batch.type = 'array'
      AND json_array_length(batch.value) BETWEEN 1 AND ${BRANCH_ACTIVITY_SCOPE_BATCH_SIZE}
  ), requested_branches AS (
    SELECT DISTINCT
      json_extract(requested.value, '$.repoFullName') AS repo_full_name,
      json_extract(requested.value, '$.branchName') AS branch_name
    FROM requested_scope_batches batch
    JOIN json_each(batch.batch_json) requested
  ), persisted_branch_candidates AS (
    SELECT
      ${normalizedRepositorySql("a.repo_full_name")} AS lookup_repo,
      ${jsTrimSql("a.branch_name")} AS lookup_branch,
      a.repo_full_name AS persisted_repo,
      a.branch_name AS persisted_branch
    FROM artifacts a
    WHERE a.kind = '${ArtifactRefTargetKind.Branch}'
      AND a.repo_full_name IS NOT NULL
      AND a.branch_name IS NOT NULL
      AND EXISTS (
        SELECT 1 FROM requested_branches rb
        WHERE ${normalizedRepositorySql("a.repo_full_name")} = rb.repo_full_name
          AND ${jsTrimSql("a.branch_name")} = rb.branch_name
      )
  ), eligible_branches AS (
    SELECT
      lookup_repo,
      lookup_branch,
      MIN(persisted_repo) AS persisted_repo,
      MIN(persisted_branch) AS persisted_branch
    FROM persisted_branch_candidates
    GROUP BY lookup_repo, lookup_branch
    HAVING COUNT(*) = 1
  ), requested_pull_requests AS (
    SELECT DISTINCT rb.repo_full_name AS lookup_repo, pr.pr_number
    FROM requested_branches rb
    JOIN pull_requests pr
      ON ${normalizedRepositorySql("pr.repo_full_name")} = rb.repo_full_name
     AND ${jsTrimSql("pr.branch_name")} = rb.branch_name
    WHERE pr.pr_number IS NOT NULL
    UNION
    SELECT DISTINCT rb.repo_full_name AS lookup_repo, a.pr_number
    FROM requested_branches rb
    JOIN artifacts a
      ON ${normalizedRepositorySql("a.repo_full_name")} = rb.repo_full_name
     AND ${jsTrimSql("a.branch_name")} = rb.branch_name
    WHERE a.kind = '${ArtifactRefTargetKind.PullRequest}'
      AND a.pr_number IS NOT NULL
  ), matching_pull_request_carriers AS (
    SELECT 1 AS unsupported
    FROM session_artifact_links sal
    JOIN artifacts a ON a.id = sal.artifact_id
    WHERE a.kind = '${ArtifactRefTargetKind.PullRequest}'
      AND a.pr_number IS NOT NULL
      AND sal.evidence IS NOT NULL
      AND ${regularCarrierEvidencePredicateSql("sal.evidence")}
      AND EXISTS (
        SELECT 1 FROM requested_pull_requests requested_pr
        WHERE ${normalizedRepositorySql("a.repo_full_name")} = requested_pr.lookup_repo
          AND a.pr_number = requested_pr.pr_number
      )
    LIMIT 1
  ), matching_private_carriers AS (
    SELECT 1 AS unsupported
    FROM sessions s
    JOIN json_each(
      ${validMetadataSql()},
      '$.${MONITORED_ACTIVITY_ONLY_METADATA_KEY}'
    ) private_rows
    WHERE ${privateCarrierMetadataPredicateSql()}
      AND json_type(private_rows.value) = 'object'
      AND (
        (
          json_extract(private_rows.value, '$.kind') = '${ArtifactRefTargetKind.Branch}'
          AND EXISTS (
            SELECT 1 FROM requested_branches rb
            WHERE ${normalizedRepositorySql("json_extract(private_rows.value, '$.repositoryFullName')")} = rb.repo_full_name
              AND ${jsTrimSql("json_extract(private_rows.value, '$.branchName')")} = rb.branch_name
          )
        ) OR (
          json_extract(private_rows.value, '$.kind') = '${ArtifactRefTargetKind.PullRequest}'
          AND EXISTS (
            SELECT 1 FROM requested_pull_requests requested_pr
            WHERE ${normalizedRepositorySql("json_extract(private_rows.value, '$.repositoryFullName')")} = requested_pr.lookup_repo
              AND json_extract(private_rows.value, '$.prNumber') = requested_pr.pr_number
          )
        )
      )
    LIMIT 1
  ), matching_regular_branch_carriers AS MATERIALIZED (
    SELECT
      sal.id AS carrier_id,
      sal.session_id,
      branch.persisted_repo,
      branch.persisted_branch,
      ${safeJsonSql("sal.evidence")} AS payload_json,
      CASE WHEN json_valid(sal.evidence) THEN 1 ELSE 0 END AS payload_valid
    FROM eligible_branches branch
    JOIN artifacts a
      ON a.kind = '${ArtifactRefTargetKind.Branch}'
     AND ${normalizedRepositorySql("a.repo_full_name")} = branch.lookup_repo
     AND ${jsTrimSql("a.branch_name")} = branch.lookup_branch
    JOIN session_artifact_links sal ON sal.artifact_id = a.id
    WHERE sal.evidence IS NOT NULL
      AND ${regularCarrierEvidencePredicateSql("sal.evidence")}
  ), carrier_activity AS MATERIALIZED (
    SELECT
      carrier.*,
      json_extract(payload_json, '$.monitoredSessionActivity') AS activity_json
    FROM matching_regular_branch_carriers carrier
  ), carrier_shapes AS MATERIALIZED (
    SELECT
      activity.*,
      CASE
        WHEN payload_valid = 1
         AND json_valid(activity_json)
         AND json_type(activity_json) = 'object'
         AND json_extract(activity_json, '$.completeness') = '${BranchActivityEvidenceCompleteness.Complete}'
         AND json_type(activity_json, '$.events') = 'array'
        THEN 1 ELSE 0
      END AS shape_valid,
      CASE
        WHEN payload_valid = 1
         AND json_valid(activity_json)
         AND json_type(activity_json) = 'object'
         AND json_type(activity_json, '$.events') = 'array'
        THEN json_array_length(activity_json, '$.events')
        ELSE 0
      END AS raw_event_count
    FROM carrier_activity activity
  ), event_shapes AS MATERIALIZED (
    SELECT
      carrier.*,
      CASE
        WHEN shape_valid = 1
         AND raw_event_count = 1
         AND json_type(activity_json, '$.events[0]') = 'object'
        THEN json_extract(activity_json, '$.events[0]')
        ELSE '{}'
      END AS event_json
    FROM carrier_shapes carrier
  ), parsed_regular_events AS MATERIALIZED (
    SELECT
      event_shapes.*,
      json_type(event_json, '$.kind') AS event_kind_type,
      json_extract(event_json, '$.kind') AS event_kind,
      json_type(event_json, '$.sourceEventId') AS source_event_id_type,
      ${jsTrimSql("json_extract(event_json, '$.sourceEventId')")} AS source_event_id,
      json_type(event_json, '$.occurredAt') AS occurred_at_type,
      json_extract(event_json, '$.occurredAt') AS occurred_at,
      ${timestampEpochMillisecondsSql("json_extract(event_json, '$.occurredAt')")} AS occurred_at_ms,
      json_type(event_json, '$.completeness') AS event_completeness_type,
      json_extract(event_json, '$.completeness') AS event_completeness,
      (SELECT COUNT(*) FROM json_each(event_json)) AS event_key_count
    FROM event_shapes
  ), simple_regular_events AS MATERIALIZED (
    SELECT
      carrier_id,
      session_id,
      persisted_repo,
      persisted_branch,
      event_kind,
      source_event_id,
      occurred_at,
      occurred_at_ms
    FROM parsed_regular_events
    WHERE shape_valid = 1
      AND raw_event_count = 1
      AND event_key_count = 4
      AND event_kind_type = 'text'
      AND event_kind IN (
        '${MonitoredSessionActivityEventKind.UserReference}',
        '${MonitoredSessionActivityEventKind.AgentRead}',
        '${MonitoredSessionActivityEventKind.AgentAction}'
      )
      AND source_event_id_type = 'text'
      AND length(source_event_id) BETWEEN 1 AND 300
      AND occurred_at_type = 'text'
      AND ${isoTimestampValidSql("occurred_at")}
      AND event_completeness_type = 'text'
      AND event_completeness = '${BranchActivityEvidenceCompleteness.Complete}'
  ), unsupported_regular_branch_carriers AS (
    SELECT 1 AS unsupported
    FROM parsed_regular_events
    WHERE NOT EXISTS (
      SELECT 1
      FROM simple_regular_events simple
      WHERE simple.carrier_id = parsed_regular_events.carrier_id
        AND simple.session_id = parsed_regular_events.session_id
        AND simple.persisted_repo = parsed_regular_events.persisted_repo
        AND simple.persisted_branch = parsed_regular_events.persisted_branch
        AND simple.source_event_id = parsed_regular_events.source_event_id
        AND simple.event_kind = parsed_regular_events.event_kind
        AND simple.occurred_at = parsed_regular_events.occurred_at
    )
    LIMIT 1
  ), carrier_cap_sessions AS (
    SELECT 1 AS unsupported
    FROM matching_regular_branch_carriers
    GROUP BY session_id
    HAVING COUNT(*) > ${MAX_SYNCED_ARTIFACT_REFS_PRODUCER}
    LIMIT 1
  ), source_conflicts AS (
    SELECT 1 AS unsupported
    FROM simple_regular_events
    GROUP BY persisted_repo, persisted_branch, source_event_id
    HAVING COUNT(DISTINCT json_array(event_kind, occurred_at)) > 1
    LIMIT 1
  ), global_events AS (
    SELECT
      persisted_repo,
      persisted_branch,
      source_event_id,
      event_kind,
      occurred_at,
      occurred_at_ms
    FROM simple_regular_events
    GROUP BY
      persisted_repo,
      persisted_branch,
      source_event_id,
      event_kind,
      occurred_at,
      occurred_at_ms
  ), ranked_global_events AS (
    SELECT
      global_events.*,
      ROW_NUMBER() OVER (
        PARTITION BY persisted_repo, persisted_branch
        ORDER BY occurred_at_ms DESC, CAST(source_event_id AS BLOB) ASC
      ) AS event_rank
    FROM global_events
  ), final_rows AS (
    SELECT
      persisted_repo AS repo_full_name,
      persisted_branch AS branch_name,
      source_event_id,
      occurred_at
    FROM ranked_global_events
    WHERE event_rank = 1
  ), fast_path_state AS (
    SELECT CASE
      WHEN EXISTS (SELECT 1 FROM matching_private_carriers)
      OR EXISTS (SELECT 1 FROM matching_pull_request_carriers)
      OR EXISTS (SELECT 1 FROM unsupported_regular_branch_carriers)
      OR EXISTS (SELECT 1 FROM carrier_cap_sessions)
      OR EXISTS (SELECT 1 FROM source_conflicts)
      THEN 0 ELSE 1
    END AS supported
  )
  SELECT
    state.supported AS "fastPathSupported",
    final.repo_full_name AS "repoFullName",
    final.branch_name AS "branchName",
    final.source_event_id AS "sourceEventId",
    final.occurred_at AS "occurredAt",
    '${BranchActivityEvidenceCompleteness.Complete}' AS "completeness"
  FROM fast_path_state state
  LEFT JOIN final_rows final ON state.supported = 1
  ORDER BY
    CAST(final.repo_full_name AS BLOB) ASC,
    CAST(final.branch_name AS BLOB) ASC,
    CAST(final.source_event_id AS BLOB) ASC`;
