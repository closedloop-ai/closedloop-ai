import {
  ArtifactRefTargetKind,
  MAX_SYNCED_ARTIFACT_REFS_PRODUCER,
} from "@repo/api/src/types/session-artifact-link";
import type { NormalizedBranchActivityScope } from "./branch-activity-identity.js";
import type { DesktopPrisma } from "./prisma-client.js";

/** Compact row kinds projected by the SQLite carrier query. */
export const BranchActivityReadRowKind = {
  BranchIdentity: "branch_identity",
  PullRequestIdentity: "pull_request_identity",
  RegularCarrier: "regular_carrier",
  PrivateCarrier: "private_carrier",
} as const;
export type BranchActivityReadRowKind =
  (typeof BranchActivityReadRowKind)[keyof typeof BranchActivityReadRowKind];

/** Internal clone-safe result shape returned by the scoped SQLite query. */
export type BranchActivityReadRawRow = {
  rowKind: BranchActivityReadRowKind;
  recordId: string | null;
  sessionId: string | null;
  targetKind: string | null;
  repoFullName: string | null;
  branchName: string | null;
  prNumber: number | bigint | null;
  payloadJson: string | null;
  privateEnvelopeValid: boolean | number | bigint | null;
  carrierOverflow: boolean | number | bigint | null;
};

/**
 * Read only identities and carrier JSON attributable to the eligible Branch
 * scope. SQLite limits each Session to the producer ref cap plus overflow
 * sentinels before any carrier JSON crosses into JavaScript.
 */
export function queryBranchActivityRows(
  prisma: DesktopPrisma,
  scopes: readonly NormalizedBranchActivityScope[]
): Promise<BranchActivityReadRawRow[]> {
  return prisma.read((reader) =>
    reader.$queryRawUnsafe<BranchActivityReadRawRow[]>(
      ACTIVITY_READ_SQL,
      JSON.stringify(scopes)
    )
  );
}

function normalizedRepositorySql(column: string): string {
  const withoutOuterSlashes = `trim(trim(${column}), '/')`;
  const withoutGitSuffix = `CASE
    WHEN lower(${withoutOuterSlashes}) LIKE '%.git'
      THEN substr(${withoutOuterSlashes}, 1, length(${withoutOuterSlashes}) - 4)
    ELSE ${withoutOuterSlashes}
  END`;
  return `lower(trim(${withoutGitSuffix}, '/'))`;
}

const BRANCH_SCOPE_SQL = `EXISTS (
  SELECT 1 FROM requested_branches rb
  WHERE ${normalizedRepositorySql("a.repo_full_name")} = rb.repo_full_name
    AND trim(a.branch_name) = rb.branch_name
)`;

const ARTIFACT_PULL_REQUEST_SCOPE_SQL = `EXISTS (
  SELECT 1 FROM requested_pull_requests requested_pr
  WHERE ${normalizedRepositorySql("a.repo_full_name")} = requested_pr.repo_full_name
    AND a.pr_number = requested_pr.pr_number
)`;

const PERSISTED_PULL_REQUEST_SCOPE_SQL = `EXISTS (
  SELECT 1 FROM requested_pull_requests requested_pr
  WHERE ${normalizedRepositorySql("pr.repo_full_name")} = requested_pr.repo_full_name
    AND pr.pr_number = requested_pr.pr_number
)`;

const PRIVATE_ACTIVITY_SCOPE_SQL = `(
  (
    json_extract(activity.value, '$.kind') = '${ArtifactRefTargetKind.Branch}'
    AND EXISTS (
      SELECT 1 FROM requested_branches rb
      WHERE ${normalizedRepositorySql("json_extract(activity.value, '$.repositoryFullName')")} = rb.repo_full_name
        AND trim(json_extract(activity.value, '$.branchName')) = rb.branch_name
    )
  ) OR (
    json_extract(activity.value, '$.kind') = '${ArtifactRefTargetKind.PullRequest}'
    AND EXISTS (
      SELECT 1 FROM requested_pull_requests requested_pr
      WHERE ${normalizedRepositorySql("json_extract(activity.value, '$.repositoryFullName')")} = requested_pr.repo_full_name
        AND json_extract(activity.value, '$.prNumber') = requested_pr.pr_number
    )
  )
)`;

const SAFE_METADATA_SQL =
  "CASE WHEN json_valid(s.metadata) THEN s.metadata ELSE '{}' END";

const ACTIVITY_READ_SQL = `WITH requested_branches(repo_full_name, branch_name) AS (
    SELECT
      json_extract(requested.value, '$.repoFullName'),
      json_extract(requested.value, '$.branchName')
    FROM json_each(?) requested
  ), requested_pull_requests(repo_full_name, pr_number) AS (
    SELECT DISTINCT rb.repo_full_name, pr.pr_number
    FROM requested_branches rb
    JOIN pull_requests pr
      ON ${normalizedRepositorySql("pr.repo_full_name")} = rb.repo_full_name
     AND trim(pr.branch_name) = rb.branch_name
    WHERE pr.pr_number IS NOT NULL
    UNION
    SELECT DISTINCT rb.repo_full_name, artifact.pr_number
    FROM requested_branches rb
    JOIN artifacts artifact
      ON ${normalizedRepositorySql("artifact.repo_full_name")} = rb.repo_full_name
     AND trim(artifact.branch_name) = rb.branch_name
    WHERE artifact.kind = '${ArtifactRefTargetKind.PullRequest}'
      AND artifact.pr_number IS NOT NULL
  ), regular_carrier_candidates AS (
    SELECT
      '${BranchActivityReadRowKind.RegularCarrier}' AS row_kind,
      sal.id AS record_id,
      sal.session_id AS session_id,
      a.kind AS target_kind,
      a.repo_full_name AS repo_full_name,
      a.branch_name AS branch_name,
      a.pr_number AS pr_number,
      json_extract(
        CASE WHEN json_valid(sal.evidence) THEN sal.evidence ELSE '{}' END,
        '$.monitoredSessionActivity'
      ) AS payload_json,
      NULL AS private_envelope_valid,
      0 AS carrier_lane,
      sal.id AS carrier_order
    FROM session_artifact_links sal
    JOIN artifacts a ON a.id = sal.artifact_id
    WHERE a.kind IN (
        '${ArtifactRefTargetKind.Branch}',
        '${ArtifactRefTargetKind.PullRequest}'
      )
      AND json_type(
        CASE WHEN json_valid(sal.evidence) THEN sal.evidence ELSE '{}' END,
        '$.monitoredSessionActivity'
      ) IS NOT NULL
      AND (
        (a.kind = '${ArtifactRefTargetKind.Branch}' AND ${BRANCH_SCOPE_SQL})
        OR
        (a.kind = '${ArtifactRefTargetKind.PullRequest}' AND ${ARTIFACT_PULL_REQUEST_SCOPE_SQL})
      )
  ), private_carrier_candidates AS (
    SELECT
      '${BranchActivityReadRowKind.PrivateCarrier}' AS row_kind,
      s.id || ':' || activity.key AS record_id,
      s.id AS session_id,
      json_extract(activity.value, '$.kind') AS target_kind,
      json_extract(activity.value, '$.repositoryFullName') AS repo_full_name,
      json_extract(activity.value, '$.branchName') AS branch_name,
      json_extract(activity.value, '$.prNumber') AS pr_number,
      activity.value AS payload_json,
      CASE
        WHEN json_type(${SAFE_METADATA_SQL}, '$.__monitoredSessionActivityRefs') = 'array'
         AND json_array_length(${SAFE_METADATA_SQL}, '$.__monitoredSessionActivityRefs') <= ${MAX_SYNCED_ARTIFACT_REFS_PRODUCER}
        THEN 1 ELSE 0
      END AS private_envelope_valid,
      1 AS carrier_lane,
      printf('%012d', CAST(activity.key AS INTEGER)) AS carrier_order
    FROM sessions s
    JOIN json_each(
      ${SAFE_METADATA_SQL},
      '$.__monitoredSessionActivityRefs'
    ) activity
    WHERE activity.type = 'object'
      AND CAST(activity.key AS INTEGER) <= ${MAX_SYNCED_ARTIFACT_REFS_PRODUCER}
      AND ${PRIVATE_ACTIVITY_SCOPE_SQL}
  ), ranked_carriers AS (
    SELECT
      candidates.*,
      ROW_NUMBER() OVER (
        PARTITION BY candidates.session_id
        ORDER BY candidates.carrier_lane, candidates.carrier_order, candidates.record_id
      ) AS carrier_rank
    FROM (
      SELECT * FROM regular_carrier_candidates
      UNION ALL
      SELECT * FROM private_carrier_candidates
    ) candidates
  ), bounded_carriers AS (
    SELECT
      row_kind,
      record_id,
      session_id,
      target_kind,
      repo_full_name,
      branch_name,
      pr_number,
      payload_json,
      private_envelope_valid,
      0 AS carrier_overflow
    FROM ranked_carriers
    WHERE carrier_rank <= ${MAX_SYNCED_ARTIFACT_REFS_PRODUCER}
    UNION ALL
    SELECT
      row_kind,
      'carrier-overflow:' || session_id || ':' || MIN(record_id) AS record_id,
      session_id,
      target_kind,
      ${normalizedRepositorySql("repo_full_name")} AS repo_full_name,
      trim(branch_name) AS branch_name,
      pr_number,
      NULL AS payload_json,
      0 AS private_envelope_valid,
      1 AS carrier_overflow
    FROM ranked_carriers
    WHERE carrier_rank > ${MAX_SYNCED_ARTIFACT_REFS_PRODUCER}
    GROUP BY
      row_kind,
      session_id,
      target_kind,
      ${normalizedRepositorySql("repo_full_name")},
      trim(branch_name),
      pr_number
  )
  SELECT
    '${BranchActivityReadRowKind.BranchIdentity}' AS "rowKind",
    a.id AS "recordId",
    NULL AS "sessionId",
    a.kind AS "targetKind",
    a.repo_full_name AS "repoFullName",
    a.branch_name AS "branchName",
    a.pr_number AS "prNumber",
    NULL AS "payloadJson",
    NULL AS "privateEnvelopeValid",
    NULL AS "carrierOverflow"
  FROM artifacts a
  WHERE a.kind = '${ArtifactRefTargetKind.Branch}'
    AND a.repo_full_name IS NOT NULL
    AND a.branch_name IS NOT NULL
    AND ${BRANCH_SCOPE_SQL}
  UNION ALL
  SELECT
    '${BranchActivityReadRowKind.PullRequestIdentity}' AS "rowKind",
    'artifact:' || a.id AS "recordId",
    NULL AS "sessionId",
    a.kind AS "targetKind",
    a.repo_full_name AS "repoFullName",
    a.branch_name AS "branchName",
    a.pr_number AS "prNumber",
    NULL AS "payloadJson",
    NULL AS "privateEnvelopeValid",
    NULL AS "carrierOverflow"
  FROM artifacts a
  WHERE a.kind = '${ArtifactRefTargetKind.PullRequest}'
    AND a.repo_full_name IS NOT NULL
    AND a.pr_number IS NOT NULL
    AND ${ARTIFACT_PULL_REQUEST_SCOPE_SQL}
  UNION ALL
  SELECT
    '${BranchActivityReadRowKind.PullRequestIdentity}' AS "rowKind",
    'pull_request:' || pr.id AS "recordId",
    NULL AS "sessionId",
    '${ArtifactRefTargetKind.PullRequest}' AS "targetKind",
    pr.repo_full_name AS "repoFullName",
    pr.branch_name AS "branchName",
    pr.pr_number AS "prNumber",
    NULL AS "payloadJson",
    NULL AS "privateEnvelopeValid",
    NULL AS "carrierOverflow"
  FROM pull_requests pr
  WHERE pr.repo_full_name IS NOT NULL
    AND pr.pr_number IS NOT NULL
    AND ${PERSISTED_PULL_REQUEST_SCOPE_SQL}
  UNION ALL
  SELECT
    row_kind AS "rowKind",
    record_id AS "recordId",
    session_id AS "sessionId",
    target_kind AS "targetKind",
    repo_full_name AS "repoFullName",
    branch_name AS "branchName",
    pr_number AS "prNumber",
    payload_json AS "payloadJson",
    private_envelope_valid AS "privateEnvelopeValid",
    carrier_overflow AS "carrierOverflow"
  FROM bounded_carriers
  ORDER BY "rowKind" ASC, "sessionId" ASC, "recordId" ASC`;
