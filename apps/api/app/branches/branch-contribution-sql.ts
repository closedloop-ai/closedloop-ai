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
import { UNCOMPUTED_SESSION_LAST_ACTIVITY_MS } from "@repo/lib/branches/branch-last-active";

/**
 * SQL predicate for an explicitly user-scoped branch contribution read.
 * Mirrors the Branches usage compatibility window: explicit `wrote` qualifies,
 * explicit `reviewed` does not, and legacy null participation remains active
 * unless its metadata clearly derives reviewed-only participation.
 *
 * The contributor is the linked session's creator
 * (`session_artifact.created_by_id`, ISS-12251 D-4).
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
      AND session_artifact.created_by_id = ${contributorUserId}::uuid
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
  return Prisma.sql`EXISTS (${branchLinkedSessionSelectSql(Prisma.sql`1`)})`;
}

/**
 * How many DISTINCT sessions that same predicate admits — the number the
 * Branches list's Sessions sort key reads off `BranchRow.sessionIds.length`.
 * Shares the predicate with {@link branchLinkedSessionExistsSql} rather than
 * restating it, so "has a session" and "how many sessions" cannot disagree.
 */
export function branchLinkedSessionCountSql() {
  return Prisma.sql`(${branchLinkedSessionSelectSql(
    Prisma.sql`COUNT(DISTINCT al.source_id)::int`
  )})`;
}

/**
 * ISS-11915: the latest computed last activity of the SAME linked sessions
 * {@link branchLinkedSessionCountSql} counts, the shared Last-active fallback
 * (`resolveBranchLastActiveMetric`) in SQL. The epoch default and non-finite
 * values are skipped exactly as the shared resolver skips them.
 */
export function branchLinkedSessionLastActivitySql() {
  return Prisma.sql`(${branchLinkedSessionSelectSql(
    Prisma.sql`MAX(sd.last_activity_at)`
  )}
      AND isfinite(sd.last_activity_at)
      AND sd.last_activity_at <> ${uncomputedSessionLastActivitySql()}
  )`;
}

/**
 * The uncomputed epoch as a `timestamp` literal (the column has no zone). A
 * literal rather than a bound `Date`, so the only instants a candidate read
 * binds are its own window and evaluation clock.
 */
function uncomputedSessionLastActivitySql(): Prisma.Sql {
  const literal = new Date(UNCOMPUTED_SESSION_LAST_ACTIVITY_MS)
    .toISOString()
    .replace("T", " ")
    .replace("Z", "");
  return Prisma.raw(`TIMESTAMP '${literal}'`);
}

function branchLinkedSessionSelectSql(projection: Prisma.Sql) {
  return Prisma.sql`
    SELECT ${projection}
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

/**
 * Product-membership Wrote evidence. Unlike usage compatibility reads, this
 * predicate requires the persisted participation literal to be explicit;
 * legacy null or metadata-inferred participation remains auditable but cannot
 * make a Branch Product-visible.
 */
export function branchProductWroteExistsSql() {
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
      AND (
        al.metadata ->> 'linkKind' IN (
          ${SessionArtifactLinkKind.SessionPr},
          ${SessionArtifactLinkKind.SessionBranch}
        )
        OR al.metadata -> 'linkKinds' @> ${JSON.stringify([
          SessionArtifactLinkKind.SessionPrSet,
        ])}::jsonb
      )
      AND al.branch_participation = ${BranchParticipationKind.Wrote}
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

/** Canonical Wrote-or-genuinely-unclassified legacy Branch membership predicate. */
export function activeWriteBranchParticipationSql() {
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
// `branch_file_changes` (the same rows `getBranchFileChangeTotals` folds into
// the row's additions/deletions). NULL-exclusion: a branch with NO file-change
// rows has unavailable LOC, so once either bound is set it is EXCLUDED (the
// EXISTS gate), mirroring the date-window null-exclusion convention.
//
// This filter and the row projection DELIBERATELY DIVERGE on a PARTIAL cache: a
// missing per-file count coalesces to 0 here, where `getBranchFileChangeTotals`
// makes the whole dimension unavailable. A range predicate has to place every
// branch on one side of a bound or the other, so it ranks a partial cache by
// what it does know; the projection has the option of saying "unknown", and
// takes it.
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
// keeps a per-file NULL count at 0 (see the divergence noted above); the outer
// SUM is NULL only when there are no rows, which the EXISTS gate has already
// excluded. Sums ALL of a branch's rows, as the row projection's own fold now
// does too — ISS-10298 removed the `take`-bounded reads this used to be the only
// unbounded reader against, so the two no longer differ on population.
function branchLocChangeSumSql(): Prisma.Sql {
  return Prisma.sql`(
    SELECT COALESCE(SUM(COALESCE(fc.additions, 0) + COALESCE(fc.deletions, 0)), 0)
    FROM branch_file_changes fc
    WHERE fc.branch_artifact_id = a.id
  )`;
}

// A branch has AVAILABLE LOC iff it has ≥1 file-change row (mirrors
// `getBranchFileChangeTotals` emitting no group for an empty change set).
function branchLocEnrichedExistsSql(): Prisma.Sql {
  return Prisma.sql`EXISTS (
    SELECT 1
    FROM branch_file_changes fc
    WHERE fc.branch_artifact_id = a.id
  )`;
}
