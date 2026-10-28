import { ArtifactType, LinkType } from "@repo/api/src/types/artifact";
import {
  BranchLifecycleBoundaryKind,
  BranchParticipationKind,
} from "@repo/api/src/types/branch";
import {
  ArtifactRefMethod,
  ArtifactRefRelation,
  SessionArtifactLinkKind,
  SessionPrRelationType,
} from "@repo/api/src/types/session-artifact-link";
import { LOC_SOURCE_BRANCH_FALLBACK } from "@repo/api/src/utils/session-loc";
import { Prisma, type withDb } from "@repo/database";

type DbClient = Parameters<Parameters<typeof withDb>[0]>[0];

export type BaselineSessionWindow = {
  organizationId: string;
  excludedSessionIds: readonly string[];
  startDate: Date;
  endDate: Date;
};

/**
 * The single row {@link queryBaselineFallbackLoc} returns: the unkeyable
 * fallback total, plus one LOC value per keyed fallback branch in
 * `(repository, branch)` order. Both halves derive from ONE `fallback_sessions`
 * CTE (ISS-9114) — they used to be two statements that each re-derived it from
 * the same window predicate.
 */
type BaselineFallbackLocRow = {
  unkeyableLoc: bigint | number | null;
  keyedLocs: readonly (bigint | number | null)[] | null;
};

/** Upper bound on distinct fallback branches summed for the baseline LOC. */
const BASELINE_FALLBACK_BRANCH_CAP = 5000;
const BASELINE_FALLBACK_BRANCH_QUERY_LIMIT = BASELINE_FALLBACK_BRANCH_CAP + 1;

/**
 * FEA-3633: baseline LOC with branch/PR-total fallback deduped per branch. The
 * non-fallback part stays a rowless Prisma aggregate; fallback rows group through
 * the SessionBranch/metric-PR link so the deleted session scalar is not needed.
 */
export async function computeDedupedBaselineLoc(
  db: DbClient,
  baseline: BaselineSessionWindow
): Promise<{ loc: number; truncated: boolean }> {
  const baselineWhere = baselineSessionWhere(baseline);
  // ISS-9114: the non-fallback aggregate and the fallback read cover disjoint
  // halves of one window and neither feeds the other, so they are issued
  // concurrently rather than awaited in turn.
  const [nonFallbackAgg, fallbackRows] = await Promise.all([
    db.sessionDetail.aggregate({
      where: {
        ...baselineWhere,
        OR: [
          { locSource: null },
          { locSource: { not: LOC_SOURCE_BRANCH_FALLBACK } },
        ],
      },
      _sum: { linesAdded: true, linesRemoved: true },
    }),
    queryBaselineFallbackLoc(db, baseline),
  ]);
  const nonFallbackLoc =
    (nonFallbackAgg._sum.linesAdded ?? 0) +
    (nonFallbackAgg._sum.linesRemoved ?? 0);

  const [fallbackRow] = fallbackRows;
  const unkeyableFallbackLoc = Number(fallbackRow?.unkeyableLoc ?? 0);
  const keyedLocs = fallbackRow?.keyedLocs ?? [];
  const truncated = keyedLocs.length > BASELINE_FALLBACK_BRANCH_CAP;
  let keyedFallbackLoc = 0;
  for (const loc of keyedLocs.slice(0, BASELINE_FALLBACK_BRANCH_CAP)) {
    keyedFallbackLoc += Number(loc ?? 0);
  }

  return {
    loc: nonFallbackLoc + unkeyableFallbackLoc + keyedFallbackLoc,
    truncated,
  };
}

export function baselineSessionWhere(
  baseline: BaselineSessionWindow
): Prisma.SessionDetailWhereInput {
  return {
    artifact: { organizationId: baseline.organizationId },
    artifactId: { notIn: [...baseline.excludedSessionIds] },
    sessionStartedAt: {
      gte: baseline.startDate,
      lte: baseline.endDate,
    },
  };
}

/**
 * Both fallback LOC halves in ONE statement (ISS-9114). The unkeyable sum and
 * the per-branch keyed groups are each a read of the SAME `fallback_sessions`
 * scope, which two statements derived twice — a full window scan joined to
 * `artifacts`, paid over again for the second half.
 *
 * The keyed half stays a list rather than a SQL sum because
 * {@link BASELINE_FALLBACK_BRANCH_CAP} truncation is detected by the group
 * COUNT, and `array_agg`'s explicit ordering keeps the retained prefix the same
 * `(repository, branch)` head the two-statement form summed.
 */
function queryBaselineFallbackLoc(
  db: DbClient,
  baseline: BaselineSessionWindow
): Promise<BaselineFallbackLocRow[]> {
  return db.$queryRaw<BaselineFallbackLocRow[]>(Prisma.sql`
    WITH fallback_sessions AS (
      ${baselineFallbackSessionSql(baseline)}
    ),
    selected_links AS (
      SELECT
        fs.artifact_id,
        fs.lines_added,
        fs.lines_removed,
        branch.repository_full_name,
        branch.branch_name,
        ROW_NUMBER() OVER (
          PARTITION BY fs.artifact_id
          ORDER BY
            CASE
              WHEN al.branch_participation = ${BranchParticipationKind.Wrote} THEN 0
              ELSE 1
            END ASC,
            branch.repository_full_name ASC,
            branch.branch_name ASC,
            al.target_id ASC
        ) AS link_rank
      FROM fallback_sessions fs
      INNER JOIN artifact_links al
        ON al.source_id = fs.artifact_id
        AND al.organization_id = ${baseline.organizationId}::uuid
        AND ${sessionLocBranchLinkSql()}
      INNER JOIN artifacts target
        ON target.id = al.target_id
        AND target.organization_id = ${baseline.organizationId}::uuid
        AND target.type = ${ArtifactType.Branch}::"ArtifactType"
      INNER JOIN branch_detail branch
        ON branch.artifact_id = target.id
    ),
    keyed_groups AS (
      SELECT
        repository_full_name,
        branch_name,
        MAX(COALESCE(lines_added, 0) + COALESCE(lines_removed, 0))::bigint AS loc
      FROM selected_links
      WHERE link_rank = 1
      GROUP BY repository_full_name, branch_name
      ORDER BY repository_full_name ASC, branch_name ASC
      LIMIT ${BASELINE_FALLBACK_BRANCH_QUERY_LIMIT}
    ),
    unkeyable AS (
      SELECT
        COALESCE(SUM(COALESCE(fs.lines_added, 0) + COALESCE(fs.lines_removed, 0)), 0)::bigint AS loc
      FROM fallback_sessions fs
      WHERE NOT EXISTS (
        SELECT 1
        FROM artifact_links al
        INNER JOIN artifacts target
          ON target.id = al.target_id
          AND target.organization_id = ${baseline.organizationId}::uuid
          AND target.type = ${ArtifactType.Branch}::"ArtifactType"
        INNER JOIN branch_detail branch
          ON branch.artifact_id = target.id
        WHERE al.organization_id = ${baseline.organizationId}::uuid
          AND al.source_id = fs.artifact_id
          AND ${sessionLocBranchLinkSql()}
      )
    )
    SELECT
      (SELECT loc FROM unkeyable) AS "unkeyableLoc",
      (
        SELECT COALESCE(
          array_agg(loc ORDER BY repository_full_name ASC, branch_name ASC),
          ARRAY[]::bigint[]
        )
        FROM keyed_groups
      ) AS "keyedLocs"
  `);
}

function baselineFallbackSessionSql(baseline: BaselineSessionWindow) {
  return Prisma.sql`
    SELECT sd.artifact_id, sd.lines_added, sd.lines_removed
    FROM session_detail sd
    INNER JOIN artifacts session_artifact
      ON session_artifact.id = sd.artifact_id
      AND session_artifact.organization_id = ${baseline.organizationId}::uuid
      AND session_artifact.type = ${ArtifactType.Session}::"ArtifactType"
    WHERE ${baselineExcludedSessionSql(baseline.excludedSessionIds)}
      AND sd.session_started_at >= ${baseline.startDate}
      AND sd.session_started_at <= ${baseline.endDate}
      AND sd.loc_source = ${LOC_SOURCE_BRANCH_FALLBACK}
  `;
}

function baselineExcludedSessionSql(sessionIds: readonly string[]) {
  if (sessionIds.length === 0) {
    return Prisma.sql`TRUE`;
  }
  return Prisma.sql`sd.artifact_id NOT IN (${Prisma.join(
    sessionIds.map((id) => Prisma.sql`${id}::uuid`)
  )})`;
}

function sessionLocBranchLinkSql() {
  return Prisma.sql`
    al.link_type = ${LinkType.RelatesTo}::"LinkType"
    AND (
      al.metadata ->> 'linkKind' IN (
        ${SessionArtifactLinkKind.SessionPr},
        ${SessionArtifactLinkKind.SessionBranch}
      )
      OR al.metadata -> 'linkKinds' @> ${JSON.stringify([
        SessionArtifactLinkKind.SessionPrSet,
      ])}::jsonb
    )
    AND ${activeWriteBranchParticipationSql()}
  `;
}

function activeWriteBranchParticipationSql() {
  return Prisma.sql`(
    al.branch_participation = ${BranchParticipationKind.Wrote}
    OR (
      al.branch_participation IS NULL
      AND NOT ${reviewedParticipationMetadataSql()}
    )
  )`;
}

function reviewedParticipationMetadataSql() {
  return Prisma.sql`(
    ${metadataBranchParticipationSql(BranchParticipationKind.Reviewed)}
    OR (
      NOT ${hasMetadataBranchParticipationSql()}
      AND NOT ${metadataRelationTypeSql(SessionPrRelationType.Created)}
      AND ${metadataRelationTypeSql(SessionPrRelationType.Reviewed)}
    )
    OR (
      NOT ${hasMetadataBranchParticipationSql()}
      AND NOT ${metadataRelationTypeSql(SessionPrRelationType.Created)}
      AND NOT ${metadataRelationTypeSql(SessionPrRelationType.Reviewed)}
      AND NOT ${metadataBranchWriteRelationSql()}
      AND ${metadataReviewEvidenceSql()}
    )
  )`;
}

function hasMetadataBranchParticipationSql() {
  return Prisma.sql`COALESCE(
    al.metadata ->> 'branchParticipation' IN (
      ${BranchParticipationKind.Wrote},
      ${BranchParticipationKind.Reviewed}
    ),
    FALSE
  )`;
}

function metadataBranchParticipationSql(kind: BranchParticipationKind) {
  return Prisma.sql`COALESCE(
    al.metadata ->> 'branchParticipation' = ${kind},
    FALSE
  )`;
}

function metadataRelationTypeSql(relationType: SessionPrRelationType) {
  return Prisma.sql`COALESCE(
    jsonb_typeof(al.metadata -> 'relationTypes') = 'array'
    AND (al.metadata -> 'relationTypes') ? ${relationType},
    FALSE
  )`;
}

function metadataBranchWriteRelationSql() {
  return Prisma.sql`COALESCE(
    al.metadata ->> 'relation' IN (
      ${ArtifactRefRelation.Created},
      ${ArtifactRefRelation.Output}
    ),
    FALSE
  )`;
}

function metadataReviewEvidenceSql() {
  return Prisma.sql`(
    COALESCE(al.metadata ->> 'relation' = ${ArtifactRefRelation.Reviewed}, FALSE)
    OR COALESCE(al.metadata ->> 'method' = ${ArtifactRefMethod.PrReviewFeedbackCommand}, FALSE)
    OR EXISTS (
      SELECT 1
      FROM jsonb_array_elements(
        CASE
          WHEN jsonb_typeof(al.metadata -> 'branchLifecycleEvents') = 'array'
            THEN al.metadata -> 'branchLifecycleEvents'
          ELSE '[]'::jsonb
        END
      ) event
      WHERE event ->> 'kind' = ${BranchLifecycleBoundaryKind.ReviewFeedback}
    )
  )`;
}
