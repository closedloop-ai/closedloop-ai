import { LinkType } from "@repo/api/src/types/artifact";
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
import { ArtifactType, Prisma } from "@repo/database";

/**
 * SQL predicate for an explicitly user-scoped branch contribution read.
 * Mirrors the Branches usage compatibility window: explicit `wrote` qualifies,
 * explicit `reviewed` does not, and legacy null participation remains active
 * unless its metadata clearly derives reviewed-only participation.
 */
export function branchContributorExistsSql(contributorUserId: string) {
  return Prisma.sql`EXISTS (
    SELECT 1
    FROM artifact_links al
    INNER JOIN artifacts session_artifact
      ON session_artifact.id = al.source_id
    INNER JOIN session_detail sd
      ON sd.artifact_id = session_artifact.id
    WHERE al.organization_id = a.organization_id
      AND al.target_id = a.id
      AND al.link_type = ${LinkType.RelatesTo}::"LinkType"
      AND session_artifact.organization_id = a.organization_id
      AND session_artifact.type = ${ArtifactType.SESSION}::"ArtifactType"
      AND sd.user_id = ${contributorUserId}::uuid
      AND ${activeWriteBranchParticipationSql()}
  )`;
}

/**
 * SQL predicate matching whether a branch has ≥1 LINKED SESSION, using the exact
 * link-kind + participation filter that `getSessionUsageByBranch` uses to build
 * `BranchRow.sessionIds` (FEA-4003). Link kind must be a session→branch usage
 * link (SessionPr / SessionBranch); participation must qualify as an active
 * `wrote` link — explicit `wrote`, or legacy `null` participation whose metadata
 * does NOT derive reviewed-only. Reuses `activeWriteBranchParticipationSql()` so
 * this EXISTS matches the `accumulateSessionLink` fold that skips Reviewed
 * (including metadata-derived-Reviewed null links) when building `sessionIds`.
 * The `INNER JOIN session_detail` enforces the FEA-4263 valid-session invariant:
 * an orphaned/half-synced link whose source SESSION has no `SessionDetail` row is
 * NOT a valid session, matching the fold's `source.session == null` skip — so a
 * branch whose only links are orphaned lands under "No session", not "Has session".
 * Callers negate this for the "No session" facet.
 */
export function branchLinkedSessionExistsSql() {
  return Prisma.sql`EXISTS (
    SELECT 1
    FROM artifact_links al
    INNER JOIN artifacts session_artifact
      ON session_artifact.id = al.source_id
    INNER JOIN session_detail sd
      ON sd.artifact_id = session_artifact.id
    WHERE al.organization_id = a.organization_id
      AND al.target_id = a.id
      AND al.link_type = ${LinkType.RelatesTo}::"LinkType"
      AND session_artifact.organization_id = a.organization_id
      AND session_artifact.type = ${ArtifactType.SESSION}::"ArtifactType"
      AND al.metadata ->> 'linkKind' IN (
        ${SessionArtifactLinkKind.SessionPr},
        ${SessionArtifactLinkKind.SessionBranch}
      )
      AND ${activeWriteBranchParticipationSql()}
  )`;
}

/**
 * FEA-4225 — whether ONE branch artifact has ≥1 VALID linked session, gating the
 * by-id branch detail read. Reuses the EXACT `branchLinkedSessionExistsSql`
 * predicate the list/counts/analytics candidate clause applies (its EXISTS keys on
 * `a.id` / `a.organization_id`, so the artifact is aliased `a` here), so detail
 * eligibility and the list corpus can never drift — in particular a branch whose
 * only link is reviewed-derived, or an orphaned link with no `SessionDetail`
 * (FEA-4263), is excluded here exactly as it is from the list.
 */
export async function branchHasLinkedSession(
  db: { $queryRaw: <T>(query: Prisma.Sql) => Promise<T> },
  organizationId: string,
  branchId: string
): Promise<boolean> {
  const rows = await db.$queryRaw<{ id: string }[]>(Prisma.sql`
    SELECT a.id
    FROM artifacts a
    WHERE a.id = ${branchId}::uuid
      AND a.organization_id = ${organizationId}::uuid
      AND a.type = ${ArtifactType.BRANCH}::"ArtifactType"
      AND ${branchLinkedSessionExistsSql()}
    LIMIT 1
  `);
  return rows.length > 0;
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
      ) AS event
      WHERE event ->> 'kind' = ${BranchLifecycleBoundaryKind.ReviewFeedback}
    )
  )`;
}

// FEA-4003 — LOC-change range over `additions + deletions`, summed from
// `branch_file_changes` (the same rows `sumFileChanges` folds into the row's
// additions/deletions). NULL-exclusion: a branch with NO file-change rows has
// unavailable LOC, so once either bound is set it is EXCLUDED (the EXISTS gate),
// mirroring the date-window null-exclusion convention. A missing per-file count
// coalesces to 0 inside the SUM, matching `sumFileChanges`.
export function appendBranchCandidateLocRangePredicate(
  predicates: Prisma.Sql[],
  min: number | undefined,
  max: number | undefined
) {
  if (min === undefined && max === undefined) {
    return;
  }
  const bounds: Prisma.Sql[] = [];
  if (min !== undefined) {
    bounds.push(Prisma.sql`${branchLocChangeSumSql()} >= ${min}`);
  }
  if (max !== undefined) {
    bounds.push(Prisma.sql`${branchLocChangeSumSql()} <= ${max}`);
  }
  predicates.push(
    Prisma.sql`(
      ${branchLocEnrichedExistsSql()}
      AND ${Prisma.join(bounds, " AND ")}
    )`
  );
}

// Scalar SUM of a branch's total LOC change from its file-change rows. COALESCE
// keeps a per-file NULL count at 0, matching `sumFileChanges`; the outer SUM is
// NULL only when there are no rows, which the EXISTS gate has already excluded.
// This sums ALL file-change rows, whereas the row projection's `sumFileChanges`
// folds only the first 500 (its `take`); for the rare branch with >500 changed
// files the filter uses the true total rather than replicating that unordered,
// nondeterministic cap — the more correct basis for a range predicate.
function branchLocChangeSumSql(): Prisma.Sql {
  return Prisma.sql`(
    SELECT COALESCE(SUM(COALESCE(fc.additions, 0) + COALESCE(fc.deletions, 0)), 0)
    FROM branch_file_changes fc
    WHERE fc.branch_artifact_id = a.id
  )`;
}

// A branch has AVAILABLE LOC iff it has ≥1 file-change row (mirrors
// `sumFileChanges` returning null only for an empty change set).
function branchLocEnrichedExistsSql(): Prisma.Sql {
  return Prisma.sql`EXISTS (
    SELECT 1
    FROM branch_file_changes fc
    WHERE fc.branch_artifact_id = a.id
  )`;
}
