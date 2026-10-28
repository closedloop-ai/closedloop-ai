import { BranchActivityEvidenceCompleteness } from "@repo/api/src/types/branch-activity";
import {
  ArtifactRefRelation,
  ArtifactRefTargetKind,
  MAX_SYNCED_ARTIFACT_REFS_PRODUCER,
  MAX_SYNCED_BRANCH_LIFECYCLE_EVENTS,
  PR_INT_MAX,
} from "@repo/api/src/types/session-artifact-link";
import { MonitoredSessionActivityEventKind } from "@repo/api/src/types/session-monitored-activity";
import {
  isoTimestampValidSql,
  jsTrimSql,
  syncTimestampValidSql,
} from "./branch-activity-timestamp-sql.js";
import { MONITORED_ACTIVITY_ONLY_METADATA_KEY } from "./synced-monitored-session-activity.js";

/** Maximum normalized Branch scopes expanded by one nested SQLite JSON walk. */
export const BRANCH_ACTIVITY_SCOPE_BATCH_SIZE = 100;

/**
 * Canonical Branch activity read. Every CTE keeps carrier and event JSON inside
 * SQLite; only the terminal one-row-per-Branch projection crosses the DB host.
 */
export const BRANCH_ACTIVITY_READ_SQL = `WITH RECURSIVE requested_scope_batches AS (
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
  ), private_activity_indices(index_value) AS (
    SELECT 0
    UNION ALL
    SELECT index_value + 1
    FROM private_activity_indices
    WHERE index_value + 1 <= ${MAX_SYNCED_ARTIFACT_REFS_PRODUCER}
  ), persisted_branch_candidates AS (
    SELECT
      a.id AS branch_id,
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
  ), pull_request_head_candidates AS (
    SELECT
      ${normalizedRepositorySql("pr.repo_full_name")} AS lookup_repo,
      pr.pr_number,
      ${jsTrimSql("pr.branch_name")} AS lookup_branch
    FROM pull_requests pr
    WHERE pr.repo_full_name IS NOT NULL
      AND pr.branch_name IS NOT NULL
      AND ${jsTrimSql("pr.branch_name")} <> ''
      AND EXISTS (
        SELECT 1 FROM requested_pull_requests requested_pr
        WHERE ${normalizedRepositorySql("pr.repo_full_name")} = requested_pr.lookup_repo
          AND pr.pr_number = requested_pr.pr_number
      )
    UNION
    SELECT
      ${normalizedRepositorySql("a.repo_full_name")} AS lookup_repo,
      a.pr_number,
      ${jsTrimSql("a.branch_name")} AS lookup_branch
    FROM artifacts a
    WHERE a.kind = '${ArtifactRefTargetKind.PullRequest}'
      AND a.repo_full_name IS NOT NULL
      AND a.branch_name IS NOT NULL
      AND ${jsTrimSql("a.branch_name")} <> ''
      AND a.pr_number IS NOT NULL
      AND EXISTS (
        SELECT 1 FROM requested_pull_requests requested_pr
        WHERE ${normalizedRepositorySql("a.repo_full_name")} = requested_pr.lookup_repo
          AND a.pr_number = requested_pr.pr_number
      )
  ), unique_pull_request_heads AS (
    SELECT lookup_repo, pr_number, MIN(lookup_branch) AS lookup_branch
    FROM pull_request_head_candidates
    GROUP BY lookup_repo, pr_number
    HAVING COUNT(DISTINCT lookup_branch) = 1
  ), regular_carrier_candidates AS (
    SELECT
      json_array(0, sal.session_id, sal.id) AS carrier_key,
      sal.id AS carrier_id,
      sal.session_id,
      0 AS carrier_lane,
      sal.id AS carrier_order,
      a.kind AS target_kind,
      ${normalizedRepositorySql("a.repo_full_name")} AS target_repo,
      CASE
        WHEN a.branch_name IS NOT NULL AND ${jsTrimSql("a.branch_name")} <> ''
          THEN ${jsTrimSql("a.branch_name")}
        ELSE NULL
      END AS target_branch,
      a.pr_number AS target_pr_number,
      ${safeJsonSql("sal.evidence")} AS payload_json,
      CASE WHEN json_valid(sal.evidence) THEN 1 ELSE 0 END AS payload_valid,
      1 AS private_outer_valid
    FROM session_artifact_links sal
    JOIN artifacts a ON a.id = sal.artifact_id
    WHERE a.kind IN (
        '${ArtifactRefTargetKind.Branch}',
        '${ArtifactRefTargetKind.PullRequest}'
      )
      AND sal.evidence IS NOT NULL
      AND ${regularCarrierEvidencePredicateSql("sal.evidence")}
      AND (
        (
          a.kind = '${ArtifactRefTargetKind.Branch}'
          AND EXISTS (
            SELECT 1 FROM requested_branches rb
            WHERE ${normalizedRepositorySql("a.repo_full_name")} = rb.repo_full_name
              AND ${jsTrimSql("a.branch_name")} = rb.branch_name
          )
        ) OR (
          a.kind = '${ArtifactRefTargetKind.PullRequest}'
          AND EXISTS (
            SELECT 1 FROM requested_pull_requests requested_pr
            WHERE ${normalizedRepositorySql("a.repo_full_name")} = requested_pr.lookup_repo
              AND a.pr_number = requested_pr.pr_number
          )
        )
      )
  ), private_carrier_rows AS (
    SELECT
      json_array(1, s.id, indices.index_value) AS carrier_key,
      s.id || ':' || indices.index_value AS carrier_id,
      s.id AS session_id,
      1 AS carrier_lane,
      printf('%012d', indices.index_value) AS carrier_order,
      json_extract(
        ${validMetadataSql()},
        '$.${MONITORED_ACTIVITY_ONLY_METADATA_KEY}[' || indices.index_value || ']'
      ) AS payload_json,
      1 AS payload_valid,
      CASE
        WHEN json_array_length(
          ${validMetadataSql()},
          '$.${MONITORED_ACTIVITY_ONLY_METADATA_KEY}'
        ) <= ${MAX_SYNCED_ARTIFACT_REFS_PRODUCER}
        THEN 1 ELSE 0
      END AS private_outer_valid
    FROM sessions s
    JOIN private_activity_indices indices
      ON indices.index_value < json_array_length(
        ${validMetadataSql()},
        '$.${MONITORED_ACTIVITY_ONLY_METADATA_KEY}'
      )
    WHERE ${privateCarrierMetadataPredicateSql()}
  ), private_carrier_candidates AS (
    SELECT
      private_rows.carrier_key,
      private_rows.carrier_id,
      private_rows.session_id,
      private_rows.carrier_lane,
      private_rows.carrier_order,
      json_extract(private_rows.payload_json, '$.kind') AS target_kind,
      ${normalizedRepositorySql("json_extract(private_rows.payload_json, '$.repositoryFullName')")} AS target_repo,
      CASE
        WHEN json_type(private_rows.payload_json, '$.branchName') = 'text'
         AND ${jsTrimSql("json_extract(private_rows.payload_json, '$.branchName')")} <> ''
          THEN ${jsTrimSql("json_extract(private_rows.payload_json, '$.branchName')")}
        ELSE NULL
      END AS target_branch,
      json_extract(private_rows.payload_json, '$.prNumber') AS target_pr_number,
      private_rows.payload_json,
      private_rows.payload_valid,
      private_rows.private_outer_valid
    FROM private_carrier_rows private_rows
    WHERE json_type(private_rows.payload_json) = 'object'
      AND (
        (
          json_extract(private_rows.payload_json, '$.kind') = '${ArtifactRefTargetKind.Branch}'
          AND EXISTS (
            SELECT 1 FROM requested_branches rb
            WHERE ${normalizedRepositorySql("json_extract(private_rows.payload_json, '$.repositoryFullName')")} = rb.repo_full_name
              AND ${jsTrimSql("json_extract(private_rows.payload_json, '$.branchName')")} = rb.branch_name
          )
        ) OR (
          json_extract(private_rows.payload_json, '$.kind') = '${ArtifactRefTargetKind.PullRequest}'
          AND EXISTS (
            SELECT 1 FROM requested_pull_requests requested_pr
            WHERE ${normalizedRepositorySql("json_extract(private_rows.payload_json, '$.repositoryFullName')")} = requested_pr.lookup_repo
              AND json_extract(private_rows.payload_json, '$.prNumber') = requested_pr.pr_number
          )
        )
      )
  ), ranked_carrier_candidates AS (
    SELECT
      candidates.*,
      ROW_NUMBER() OVER (
        PARTITION BY session_id
        ORDER BY carrier_lane, CAST(carrier_order AS BLOB), carrier_key
      ) AS carrier_rank
    FROM (
      SELECT * FROM regular_carrier_candidates
      UNION ALL
      SELECT * FROM private_carrier_candidates
    ) candidates
  ), resolved_carriers AS (
    SELECT ranked.*, branch.persisted_repo, branch.persisted_branch
    FROM ranked_carrier_candidates ranked
    JOIN eligible_branches branch
      ON ranked.target_repo = branch.lookup_repo
     AND ranked.target_branch = branch.lookup_branch
    WHERE ranked.target_kind = '${ArtifactRefTargetKind.Branch}'
    UNION ALL
    SELECT ranked.*, branch.persisted_repo, branch.persisted_branch
    FROM ranked_carrier_candidates ranked
    JOIN unique_pull_request_heads head
      ON ranked.target_repo = head.lookup_repo
     AND ranked.target_pr_number = head.pr_number
    JOIN eligible_branches branch
      ON head.lookup_repo = branch.lookup_repo
     AND head.lookup_branch = branch.lookup_branch
    WHERE ranked.target_kind = '${ArtifactRefTargetKind.PullRequest}'
      AND typeof(ranked.target_pr_number) IN ('integer', 'real')
      AND ranked.target_pr_number = CAST(ranked.target_pr_number AS INTEGER)
      AND ranked.target_pr_number BETWEEN 1 AND 9007199254740991
      AND (
        ranked.target_branch IS NULL
        OR ranked.target_branch = head.lookup_branch
      )
  ), bounded_carriers AS (
    SELECT * FROM resolved_carriers
    WHERE carrier_rank <= ${MAX_SYNCED_ARTIFACT_REFS_PRODUCER}
  ), carrier_overflow_sessions AS (
    SELECT DISTINCT session_id
    FROM resolved_carriers
    WHERE carrier_rank > ${MAX_SYNCED_ARTIFACT_REFS_PRODUCER}
    UNION
    SELECT DISTINCT session_id
    FROM resolved_carriers
    WHERE private_outer_valid = 0
  ), carrier_overflow_issues AS (
    SELECT DISTINCT
      resolved.persisted_repo,
      resolved.persisted_branch,
      'carrier-cap:' || resolved.session_id AS issue_id
    FROM resolved_carriers resolved
    JOIN carrier_overflow_sessions overflow
      ON overflow.session_id = resolved.session_id
  ), carrier_activity AS MATERIALIZED (
    SELECT
      bounded.*,
      json_extract(payload_json, '$.monitoredSessionActivity') AS activity_json,
      CASE
        WHEN carrier_lane = 0 THEN 1
        WHEN private_outer_valid = 1 AND ${privateRefEnvelopeValidSql("payload_json")}
          THEN 1
        ELSE 0
      END AS envelope_valid
    FROM bounded_carriers bounded
    WHERE carrier_lane = 1
      OR payload_valid = 0
      OR json_type(payload_json, '$.monitoredSessionActivity') IS NOT NULL
  ), carrier_shapes AS MATERIALIZED (
    SELECT
      carrier_activity.*,
      CASE
        WHEN envelope_valid = 1
         AND json_valid(activity_json)
         AND json_type(activity_json) = 'object'
         AND json_type(activity_json, '$.events') = 'array'
        THEN 1 ELSE 0
      END AS shape_valid,
      CASE
        WHEN json_valid(activity_json) AND json_type(activity_json) = 'object'
          THEN json_extract(activity_json, '$.completeness')
        ELSE NULL
      END AS declared_completeness
    FROM carrier_activity
  ), raw_event_rows AS MATERIALIZED (
    SELECT
      carrier.carrier_key,
      carrier.carrier_id,
      carrier.session_id,
      carrier.persisted_repo,
      carrier.persisted_branch,
      ev.key AS raw_index,
      ev.type AS event_type,
      CASE WHEN ev.type = 'object' THEN ev.value ELSE '{}' END AS event_json
    FROM carrier_shapes carrier
    JOIN json_each(
      CASE WHEN carrier.shape_valid = 1 THEN carrier.activity_json ELSE '{}' END,
      '$.events'
    ) ev
  ), parsed_event_rows AS MATERIALIZED (
    SELECT
      raw.*,
      json_extract(event_json, '$.kind') AS event_kind,
      ${jsTrimSql("json_extract(event_json, '$.sourceEventId')")} AS source_event_id,
      json_extract(event_json, '$.occurredAt') AS occurred_at,
      ${timestampEpochMillisecondsSql("json_extract(event_json, '$.occurredAt')")} AS occurred_at_ms,
      json_extract(event_json, '$.completeness') AS event_completeness,
      CASE
        WHEN event_type = 'object'
         AND (SELECT COUNT(*) FROM json_each(event_json)) = 4
         AND json_type(event_json, '$.kind') = 'text'
         AND json_extract(event_json, '$.kind') IN (
           '${MonitoredSessionActivityEventKind.UserReference}',
           '${MonitoredSessionActivityEventKind.AgentRead}',
           '${MonitoredSessionActivityEventKind.AgentAction}'
         )
         AND json_type(event_json, '$.sourceEventId') = 'text'
         AND length(${jsTrimSql("json_extract(event_json, '$.sourceEventId')")}) BETWEEN 1 AND 300
         AND json_type(event_json, '$.occurredAt') = 'text'
         AND ${isoTimestampValidSql("json_extract(event_json, '$.occurredAt')")}
         AND json_type(event_json, '$.completeness') = 'text'
         AND json_extract(event_json, '$.completeness') IN (
           '${BranchActivityEvidenceCompleteness.Complete}',
           '${BranchActivityEvidenceCompleteness.Partial}'
         )
        THEN 1 ELSE 0
      END AS event_valid
    FROM raw_event_rows raw
  ), raw_event_summaries AS (
    SELECT
      carrier_key,
      SUM(CASE WHEN event_valid = 0 THEN 1 ELSE 0 END) AS invalid_event_count
    FROM parsed_event_rows
    GROUP BY carrier_key
  ), valid_event_rows AS (
    SELECT * FROM parsed_event_rows WHERE event_valid = 1
  ), carrier_source_stats AS (
    SELECT
      carrier_key,
      carrier_id,
      session_id,
      persisted_repo,
      persisted_branch,
      source_event_id,
      COUNT(DISTINCT json_array(event_kind, occurred_at, event_completeness)) AS signature_count,
      MIN(event_kind) AS event_kind,
      MIN(occurred_at) AS occurred_at,
      MIN(occurred_at_ms) AS occurred_at_ms,
      MIN(event_completeness) AS event_completeness
    FROM valid_event_rows
    GROUP BY
      carrier_key,
      carrier_id,
      session_id,
      persisted_repo,
      persisted_branch,
      source_event_id
  ), deduplicated_carrier_events AS (
    SELECT * FROM carrier_source_stats WHERE signature_count = 1
  ), carrier_event_summaries AS (
    SELECT
      carrier_key,
      SUM(CASE WHEN signature_count > 1 THEN 1 ELSE 0 END) AS conflict_count,
      SUM(CASE WHEN signature_count = 1 THEN 1 ELSE 0 END) AS retained_count,
      MAX(CASE
        WHEN signature_count = 1
         AND event_completeness = '${BranchActivityEvidenceCompleteness.Partial}'
        THEN 1 ELSE 0
      END) AS has_partial
    FROM carrier_source_stats
    GROUP BY carrier_key
  ), carrier_quality AS MATERIALIZED (
    SELECT
      carrier.*,
      COALESCE(raw.invalid_event_count, 0) AS invalid_event_count,
      COALESCE(summary.conflict_count, 0) AS conflict_count,
      COALESCE(summary.retained_count, 0) AS retained_count,
      COALESCE(summary.has_partial, 0) AS has_partial
    FROM carrier_shapes carrier
    LEFT JOIN raw_event_summaries raw ON raw.carrier_key = carrier.carrier_key
    LEFT JOIN carrier_event_summaries summary
      ON summary.carrier_key = carrier.carrier_key
  ), ranked_carrier_events AS (
    SELECT
      quality.session_id,
      quality.carrier_key,
      quality.carrier_id,
      quality.persisted_repo,
      quality.persisted_branch,
      event.event_kind,
      event.source_event_id,
      event.occurred_at,
      event.occurred_at_ms,
      CASE
        WHEN quality.declared_completeness <> '${BranchActivityEvidenceCompleteness.Complete}'
          OR quality.declared_completeness IS NULL
          OR quality.invalid_event_count > 0
          OR quality.conflict_count > 0
          OR quality.has_partial = 1
        THEN '${BranchActivityEvidenceCompleteness.Partial}'
        ELSE '${BranchActivityEvidenceCompleteness.Complete}'
      END AS event_completeness
    FROM carrier_quality quality
    JOIN deduplicated_carrier_events event
      ON event.carrier_key = quality.carrier_key
    WHERE quality.shape_valid = 1
      AND quality.retained_count > 0
  ), normalized_carrier_events AS (
    SELECT
      ranked.session_id,
      ranked.persisted_repo,
      ranked.persisted_branch,
      ranked.event_kind,
      ranked.source_event_id,
      ranked.occurred_at,
      ranked.occurred_at_ms,
      CASE
        WHEN overflow.session_id IS NOT NULL
          THEN '${BranchActivityEvidenceCompleteness.Partial}'
        ELSE ranked.event_completeness
      END AS event_completeness
    FROM ranked_carrier_events ranked
    LEFT JOIN carrier_overflow_sessions overflow
      ON overflow.session_id = ranked.session_id
  ), malformed_carrier_issues AS (
    SELECT
      quality.persisted_repo,
      quality.persisted_branch,
      'malformed-carrier:' || quality.carrier_id AS issue_id
    FROM carrier_quality quality
    WHERE quality.shape_valid = 0 OR quality.retained_count = 0
  ), session_source_stats AS (
    SELECT
      session_id,
      persisted_repo,
      persisted_branch,
      source_event_id,
      COUNT(DISTINCT json_array(event_kind, occurred_at)) AS signature_count,
      MIN(event_kind) AS event_kind,
      MIN(occurred_at) AS occurred_at,
      MIN(occurred_at_ms) AS occurred_at_ms,
      CASE
        WHEN MAX(CASE
          WHEN event_completeness = '${BranchActivityEvidenceCompleteness.Partial}'
          THEN 1 ELSE 0
        END) = 1 THEN '${BranchActivityEvidenceCompleteness.Partial}'
        ELSE '${BranchActivityEvidenceCompleteness.Complete}'
      END AS event_completeness
    FROM normalized_carrier_events
    GROUP BY session_id, persisted_repo, persisted_branch, source_event_id
  ), session_conflict_issues AS (
    SELECT
      persisted_repo,
      persisted_branch,
      'conflicting-source:' || source_event_id AS issue_id
    FROM session_source_stats
    WHERE signature_count > 1
  ), session_events AS (
    SELECT * FROM session_source_stats WHERE signature_count = 1
  ), partial_event_issues AS (
    SELECT DISTINCT
      persisted_repo,
      persisted_branch,
      'partial-source:' || source_event_id AS issue_id
    FROM session_events
    WHERE event_completeness = '${BranchActivityEvidenceCompleteness.Partial}'
  ), global_source_stats AS (
    SELECT
      persisted_repo,
      persisted_branch,
      source_event_id,
      COUNT(DISTINCT json_array(event_kind, occurred_at)) AS signature_count,
      MIN(event_kind) AS event_kind,
      MIN(occurred_at) AS occurred_at,
      MIN(occurred_at_ms) AS occurred_at_ms,
      CASE
        WHEN MAX(CASE
          WHEN event_completeness = '${BranchActivityEvidenceCompleteness.Partial}'
          THEN 1 ELSE 0
        END) = 1 THEN '${BranchActivityEvidenceCompleteness.Partial}'
        ELSE '${BranchActivityEvidenceCompleteness.Complete}'
      END AS event_completeness
    FROM session_events
    GROUP BY persisted_repo, persisted_branch, source_event_id
  ), global_conflict_issues AS (
    SELECT
      persisted_repo,
      persisted_branch,
      'conflicting-source:' || source_event_id AS issue_id
    FROM global_source_stats
    WHERE signature_count > 1
  ), global_events AS (
    SELECT * FROM global_source_stats WHERE signature_count = 1
  ), coverage_issues AS (
    SELECT * FROM carrier_overflow_issues
    UNION
    SELECT * FROM malformed_carrier_issues
    UNION
    SELECT * FROM session_conflict_issues
    UNION
    SELECT * FROM partial_event_issues
    UNION
    SELECT * FROM global_conflict_issues
  ), branch_states AS (
    SELECT persisted_repo, persisted_branch FROM global_events
    UNION
    SELECT persisted_repo, persisted_branch FROM coverage_issues
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
      state.persisted_repo AS repo_full_name,
      state.persisted_branch AS branch_name,
      COALESCE(latest.source_event_id, MIN(issue.issue_id)) AS source_event_id,
      latest.occurred_at,
      CASE
        WHEN COUNT(issue.issue_id) > 0
          THEN '${BranchActivityEvidenceCompleteness.Partial}'
        ELSE '${BranchActivityEvidenceCompleteness.Complete}'
      END AS completeness
    FROM branch_states state
    LEFT JOIN ranked_global_events latest
      ON latest.persisted_repo = state.persisted_repo
     AND latest.persisted_branch = state.persisted_branch
     AND latest.event_rank = 1
    LEFT JOIN coverage_issues issue
      ON issue.persisted_repo = state.persisted_repo
     AND issue.persisted_branch = state.persisted_branch
    GROUP BY
      state.persisted_repo,
      state.persisted_branch,
      latest.source_event_id,
      latest.occurred_at
  )
  SELECT
    repo_full_name AS "repoFullName",
    branch_name AS "branchName",
    source_event_id AS "sourceEventId",
    occurred_at AS "occurredAt",
    completeness
  FROM final_rows
  WHERE source_event_id IS NOT NULL
  ORDER BY
    CAST(repo_full_name AS BLOB) ASC,
    CAST(branch_name AS BLOB) ASC,
    CAST(source_event_id AS BLOB) ASC`;

/**
 * Cheap global preflight for corpora that cannot produce canonical activity.
 *
 * The full reconciliation below must still run for malformed carriers because
 * those degrade availability to Partial. This probe therefore checks for any
 * carrier that could enter reconciliation, not only valid monitored activity
 * payloads.
 */
export const BRANCH_ACTIVITY_CARRIER_EXISTS_SQL = `SELECT CASE
  WHEN EXISTS (
    SELECT 1
    FROM session_artifact_links sal
    JOIN artifacts a ON a.id = sal.artifact_id
    WHERE a.kind IN (
        '${ArtifactRefTargetKind.Branch}',
        '${ArtifactRefTargetKind.PullRequest}'
      )
      AND sal.evidence IS NOT NULL
      AND ${regularCarrierEvidencePredicateSql("sal.evidence")}
    LIMIT 1
  ) OR EXISTS (
    SELECT 1
    FROM sessions s
    WHERE ${privateCarrierMetadataPredicateSql()}
    LIMIT 1
  )
  THEN 1 ELSE 0 END AS "hasCarrier"`;

export function normalizedRepositorySql(column: string): string {
  const withoutOuterSlashes = `trim(${jsTrimSql(column)}, '/')`;
  const withoutGitSuffix = `CASE
    WHEN lower(${withoutOuterSlashes}) LIKE '%.git'
      THEN substr(${withoutOuterSlashes}, 1, length(${withoutOuterSlashes}) - 4)
    ELSE ${withoutOuterSlashes}
  END`;
  return `lower(trim(${withoutGitSuffix}, '/'))`;
}

export function validMetadataSql(): string {
  return "CASE WHEN json_valid(s.metadata) THEN s.metadata ELSE '{}' END";
}

export function regularCarrierEvidencePredicateSql(
  evidenceColumn: string
): string {
  return `(
        json_valid(${evidenceColumn}) = 0
        OR json_type(
          ${safeJsonSql(evidenceColumn)},
          '$.monitoredSessionActivity'
        ) IS NOT NULL
      )`;
}

export function privateCarrierMetadataPredicateSql(): string {
  return `json_type(
      ${validMetadataSql()},
      '$.${MONITORED_ACTIVITY_ONLY_METADATA_KEY}'
    ) = 'array'`;
}

function privateRefEnvelopeValidSql(payload: string): string {
  const observedAt = `json_extract(${payload}, '$.observedAt')`;
  return `(
    json_type(${payload}, '$.repositoryFullName') = 'text'
    AND length(json_extract(${payload}, '$.repositoryFullName')) BETWEEN 1 AND 200
    AND json_type(${payload}, '$.method') = 'text'
    AND length(json_extract(${payload}, '$.method')) BETWEEN 1 AND 200
    AND json_extract(${payload}, '$.relation') IN (
      '${ArtifactRefRelation.Input}',
      '${ArtifactRefRelation.Output}',
      '${ArtifactRefRelation.Referenced}',
      '${ArtifactRefRelation.Created}',
      '${ArtifactRefRelation.Reviewed}',
      '${ArtifactRefRelation.Workspace}'
    )
    AND json_type(${payload}, '$.monitoredActivityOnly') = 'true'
    AND (
      json_type(${payload}, '$.observedAt') IS NULL
      OR (
        json_type(${payload}, '$.observedAt') = 'text'
        AND ${syncTimestampValidSql(observedAt)}
      )
    )
    AND ${privateTargetValidSql(payload)}
    AND ${privateLifecycleEventsValidSql(payload)}
    AND ${privatePullRequestFieldsValidSql(payload)}
  )`;
}

function privateTargetValidSql(payload: string): string {
  return `(
    (
      json_extract(${payload}, '$.kind') = '${ArtifactRefTargetKind.Branch}'
      AND json_type(${payload}, '$.branchName') = 'text'
      AND length(json_extract(${payload}, '$.branchName')) BETWEEN 1 AND 300
    ) OR (
      json_extract(${payload}, '$.kind') = '${ArtifactRefTargetKind.PullRequest}'
      AND json_type(${payload}, '$.prNumber') IN ('integer', 'real')
      AND json_extract(${payload}, '$.prNumber') = CAST(json_extract(${payload}, '$.prNumber') AS INTEGER)
      AND json_extract(${payload}, '$.prNumber') BETWEEN 1 AND 9007199254740991
      AND (
        json_type(${payload}, '$.branchName') IS NULL
        OR (
          json_type(${payload}, '$.branchName') = 'text'
          AND length(json_extract(${payload}, '$.branchName')) BETWEEN 1 AND 300
        )
      )
    )
  )`;
}

function privateLifecycleEventsValidSql(payload: string): string {
  return `(
    json_type(${payload}, '$.branchLifecycleEvents') IS NULL
    OR (
      json_type(${payload}, '$.branchLifecycleEvents') = 'array'
      AND json_array_length(${payload}, '$.branchLifecycleEvents') <= ${MAX_SYNCED_BRANCH_LIFECYCLE_EVENTS}
      AND NOT EXISTS (
        SELECT 1
        FROM json_each(${payload}, '$.branchLifecycleEvents') lifecycle
        WHERE lifecycle.type <> 'object'
          OR (
            json_type(lifecycle.value, '$.observedAt') IS NOT NULL
            AND (
              json_type(lifecycle.value, '$.observedAt') <> 'text'
              OR NOT ${syncTimestampValidSql("json_extract(lifecycle.value, '$.observedAt')")}
            )
          )
          OR (
            json_type(lifecycle.value, '$.evidenceId') IS NOT NULL
            AND (
              json_type(lifecycle.value, '$.evidenceId') <> 'text'
              OR length(json_extract(lifecycle.value, '$.evidenceId')) NOT BETWEEN 1 AND 500
            )
          )
      )
    )
  )`;
}

function privatePullRequestFieldsValidSql(payload: string): string {
  return `(
    json_extract(${payload}, '$.kind') <> '${ArtifactRefTargetKind.PullRequest}'
    OR (
      ${optionalStringSql(payload, "title", 0, 1024)}
      AND ${optionalBooleanSql(payload, "isDraft")}
      AND ${optionalIntegerSql(payload, "additions", 0, PR_INT_MAX)}
      AND ${optionalIntegerSql(payload, "deletions", 0, PR_INT_MAX)}
      AND ${optionalIntegerSql(payload, "changedFiles", 0, PR_INT_MAX)}
      AND ${optionalParseableTimestampSql(payload, "mergedAt")}
      AND ${optionalParseableTimestampSql(payload, "closedAt")}
    )
  )`;
}

function optionalStringSql(
  payload: string,
  key: string,
  minimum: number,
  maximum: number
): string {
  return `(
    json_type(${payload}, '$.${key}') IS NULL
    OR (
      json_type(${payload}, '$.${key}') = 'text'
      AND length(json_extract(${payload}, '$.${key}')) BETWEEN ${minimum} AND ${maximum}
    )
  )`;
}

function optionalBooleanSql(payload: string, key: string): string {
  return `(
    json_type(${payload}, '$.${key}') IS NULL
    OR json_type(${payload}, '$.${key}') IN ('true', 'false')
  )`;
}

function optionalIntegerSql(
  payload: string,
  key: string,
  minimum: number,
  maximum: number
): string {
  const value = `json_extract(${payload}, '$.${key}')`;
  return `(
    json_type(${payload}, '$.${key}') IS NULL
    OR (
      json_type(${payload}, '$.${key}') IN ('integer', 'real')
      AND ${value} = CAST(${value} AS INTEGER)
      AND ${value} BETWEEN ${minimum} AND ${maximum}
    )
  )`;
}

function optionalParseableTimestampSql(payload: string, key: string): string {
  const value = `json_extract(${payload}, '$.${key}')`;
  return `(
    json_type(${payload}, '$.${key}') IS NULL
    OR (
      json_type(${payload}, '$.${key}') = 'text'
      AND ${syncTimestampValidSql(value)}
    )
  )`;
}

export function safeJsonSql(value: string): string {
  return `CASE WHEN json_valid(${value}) THEN ${value} ELSE '{}' END`;
}

export function timestampEpochMillisecondsSql(value: string): string {
  const wholeSeconds = `CASE
    WHEN length(${value}) = 17 THEN substr(${value}, 1, 16) || ':00Z'
    ELSE substr(${value}, 1, 19) || 'Z'
  END`;
  const milliseconds = `CASE
    WHEN substr(${value}, 20, 1) = '.'
      THEN CAST(substr(${value} || '000', 21, 3) AS INTEGER)
    ELSE 0
  END`;
  return `(unixepoch(${wholeSeconds}) * 1000 + ${milliseconds})`;
}
