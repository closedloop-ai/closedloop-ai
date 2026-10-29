/**
 * ISS-8153 (PRD-683 P2-A, Decision 3) — the ORG-MERGED pull-request population.
 *
 * One of the TWO sanctioned PR populations (the other is the branch-canonical
 * resolution in `apps/api/app/branches/branch-canonical-pull-request.ts`).
 * Anything that counts pull requests ACROSS an org — Insights Delivery, the
 * profile "PRs landed" figures, cohort metrics — must compose this predicate
 * or carry a documented exemption in the
 * `pull-request-population-declaration` source gate's allowlist.
 *
 * Membership (Kerensa's D1 ruling, 2026-08-27, revising the executed shape): a
 * merged PR row counts ONLY when it is SESSION-LINKED AND VERIFIED
 * (`lastVerifiedAt` stamped, D2). The SESSION-LINKED half is lane-agnostic: a
 * webhook/App projection, a desktop upload, and a server-side fetch are all
 * excluded alike when no session reference exists — "no session reference, not
 * included."
 *
 * The VERIFIED half is NOT a lane fact either, but for the opposite reason
 * (Kerensa's ISS-8423 ruling, 2026-08-28, correcting the earlier "it does not
 * matter which lane wrote the row" reading of D2): `lastVerifiedAt` asserts
 * that a producer OBSERVED this pull request, not that some lane touched the
 * row. A desktop `pull_request` ref that carried no facts writes nothing but a
 * server-derived `html_url` over the `pr_state` column default, so it no longer
 * stamps the column and no longer enters this population. Which is only
 * academic here — a stub is `OPEN` and this predicate also requires MERGED —
 * but the same stamp gates seven other consumers where it is not.
 *
 * SESSION-LINKED means a Metric audience session→PR link whose metadata admits
 * the SAME persisted PR identity (`repo#number`), with the historical
 * unique-Branch fallback left for legacy links that predate metadata identity.
 * Repository-less tier-2 PR rows also admit through command-derived session→Branch
 * evidence, but only after provider verification and only when the Branch carries
 * exactly one PR row. A bare session→branch link never admits installed/App rows
 * or a reused-Branch sibling.
 *
 * What that deliberately excludes: retired-genesis rows (never linked, never
 * verified — ISS-8149 deletes them), repo-wide pooled-token fetches
 * (ISS-7721), and webhook-projected PRs no session touched.
 */
import { ArtifactType, LinkType } from "@repo/api/src/types/artifact";
import { BranchParticipationKind } from "@repo/api/src/types/branch";
import { GitHubPRState } from "@repo/api/src/types/github-status";
import {
  ArtifactRefMethod,
  SessionArtifactLinkKind,
} from "@repo/api/src/types/session-artifact-link";
import { Prisma, type PrismaClient } from "@repo/database";
import pLimit from "p-limit";
import {
  buildSessionPrAdmissionIndex,
  type LinkedBranchArtifact,
  type SessionLinkedPrDetail,
  type SessionPrBranchAdmission,
  sessionBranchPrPopulationLinkWhere,
  sessionLinkedBranches,
  sessionLinkedPopulationArms,
} from "@/lib/session-pr-links";
import { readInIdChunks } from "@/lib/session-pr-links-chunking";

/**
 * The session→PR link predicate for population membership: any session, Metric
 * audience (prose-derived links must not move a count — ISS-5823).
 *
 * `organizationId` is required for index reachability, not tenancy (callers
 * already scope the branch artifact): every `artifact_links` index leads with
 * the org (`@@index([organizationId, targetId, linkType])`), so an org-free
 * link filter sequential-scans the org-wide edge table on the Delivery hot
 * path.
 */
export function sessionLinkedPullRequestLinkWhere(
  organizationId: string
): Prisma.ArtifactLinkWhereInput {
  return {
    organizationId,
    linkType: LinkType.RelatesTo,
    // The SOURCE session carries its own org check: nothing in the schema
    // forces a link's source artifact into the link's org, so a foreign-org
    // session must not admit this org's branch (cr on PR #6112).
    source: { type: ArtifactType.Session, organizationId },
    // ISS-7905 moved the arm list into `session-pr-links.ts` — the module the
    // source gate names as the owner of the session-link predicate — so this
    // population and the Sessions delivery cards compose ONE spelling. Two
    // copies is how the two surfaces came to admit different link shapes.
    OR: sessionLinkedPopulationArms(),
  };
}

/**
 * The merged+verified half of membership — the one spelling both the
 * PR-shaped and branch-shaped forms below derive from, so a rule change lands
 * in every dialect or none.
 */
export function mergedVerifiedPullRequestWhere(
  mergedAt: Prisma.DateTimeNullableFilter | undefined
): Prisma.PullRequestDetailWhereInput {
  return {
    prState: GitHubPRState.Merged,
    mergedAt,
    lastVerifiedAt: { not: null },
  };
}

/**
 * The org-merged population. `branchArtifactScope` is the caller-resolved
 * artifact scope (org / me / team) — passed in so this module stays free of the
 * insights scope-context type, same shape as `fetchBranchesWithoutPrBuckets`.
 */
export function orgMergedPullRequestWhere(input: {
  organizationId: string;
  branchArtifactScope: Prisma.ArtifactWhereInput;
  mergedAt: Prisma.DateTimeNullableFilter;
}): Prisma.PullRequestDetailWhereInput {
  return {
    ...mergedVerifiedPullRequestWhere(input.mergedAt),
    branchArtifact: {
      is: {
        AND: [
          input.branchArtifactScope,
          {
            targetLinks: {
              some: sessionLinkedPullRequestLinkWhere(input.organizationId),
            },
          },
        ],
      },
    },
  };
}

/**
 * Raw-SQL mirror of the membership predicate (session-linked AND verified)
 * over the `p` (pull_request_detail) alias, for the distinct-identity counts
 * that aggregate in Postgres and cannot use a Prisma relation filter.
 * Installed/App rows are admitted by exact `repo#number` identity; the
 * repository-less tier-2 branch arm stays branch-level. `organizationId` leads
 * the EXISTS so it walks
 * `@@index([organizationId, targetId, linkType])` (see
 * {@link sessionLinkedPullRequestLinkWhere}).
 */
export function orgMergedPullRequestMembershipSql(
  organizationId: string
): Prisma.Sql {
  return Prisma.sql`(
    p.last_verified_at IS NOT NULL
    AND ${sessionLinkedPullRequestMembershipSql(organizationId)}
  )`;
}

/**
 * Read the exact Metric session→PR admission index for a set of candidate
 * branches. This is the TypeScript mirror of
 * {@link orgMergedPullRequestMembershipSql}; callers supply candidate branches
 * they already hydrated so this helper only reads the link rows needed to decide
 * identity admission.
 *
 * ISS-6136: this read stays ONE chunk at a time, unlike its siblings.
 *
 * `db` is the CALLER'S client, and every caller reaches here through
 * `loadOrgMergedPullRequestAdmissionForRows` inside
 * `withBranchProductReadSnapshot` — a RepeatableRead interactive transaction. A
 * transaction client is pinned to one connection, so node-postgres queues the
 * statements and a wider limiter buys no overlap at all. What it WOULD buy is a
 * failure mode: when one chunk rejects, the sibling statements already issued
 * run against an aborted transaction and each comes back `25P02`, turning one
 * legible error into N. Concurrency is only worth having where the statements
 * can actually overlap.
 */
export async function readOrgMergedPullRequestAdmissionByBranchId(
  db: Pick<PrismaClient, "artifactLink">,
  organizationId: string,
  sources: readonly OrgMergedPullRequestAdmissionSource[]
): Promise<OrgMergedPullRequestAdmissionMap> {
  const pullRequestCountByBranchId = new Map<string, number>();
  for (const source of sources) {
    pullRequestCountByBranchId.set(
      source.branchArtifact.id,
      source.branchArtifact._count.pullRequestDetails
    );
  }
  const branchIds = [...pullRequestCountByBranchId.keys()];
  // Built PER CALL, never at module scope. A module-level `pLimit(1)` is shared
  // by every concurrent request, so request B's chunks queue behind request A's
  // while both hold their own 15-second RepeatableRead snapshot — turning a
  // per-transaction sequencing rule into cross-request head-of-line blocking
  // that can time the waiter out. The rule is per-transaction; so is the limiter.
  const sequentialChunks = pLimit(1);
  const links = await readInIdChunks(
    branchIds,
    (chunk) =>
      db.artifactLink.findMany({
        where: {
          targetId: { in: chunk },
          OR: [
            sessionLinkedPullRequestLinkWhere(organizationId),
            {
              organizationId,
              ...sessionBranchPrPopulationLinkWhere(),
              source: { type: ArtifactType.Session, organizationId },
            },
          ],
        },
        select: { targetId: true, metadata: true, branchParticipation: true },
      }),
    sequentialChunks
  );
  return buildSessionPrAdmissionIndex(links, pullRequestCountByBranchId);
}

/** Whether the shared Metric PR universe admits this verified PR row. */
export function isOrgPullRequestMetricDetail(
  detail: OrgPullRequestMetricDetail,
  admissionByBranchId: OrgMergedPullRequestAdmissionMap
): boolean {
  return (
    detail.lastVerifiedAt !== null &&
    sessionLinkedBranches(detail, admissionByBranchId).length > 0
  );
}

/** Whether the shared org-merged population admits this PR row. */
export function isOrgMergedPullRequestDetail(
  detail: OrgPullRequestMetricDetail,
  admissionByBranchId: OrgMergedPullRequestAdmissionMap
): boolean {
  return (
    detail.prState === GitHubPRState.Merged &&
    detail.mergedAt !== null &&
    isOrgPullRequestMetricDetail(detail, admissionByBranchId)
  );
}

/** Filter hydrated PR rows down to the final shared org-merged population. */
export function filterOrgMergedPullRequestDetails<
  Detail extends OrgPullRequestMetricDetail,
>(
  details: readonly Detail[],
  admissionByBranchId: OrgMergedPullRequestAdmissionMap
): Detail[] {
  return details.filter((detail) =>
    isOrgMergedPullRequestDetail(detail, admissionByBranchId)
  );
}

export type OrgMergedPullRequestAdmissionMap = ReadonlyMap<
  string,
  SessionPrBranchAdmission
>;

export type OrgMergedPullRequestAdmissionSource = LinkedBranchArtifact;

export type OrgPullRequestMetricDetail = SessionLinkedPrDetail & {
  repositoryId: string | null;
  prState: string | null;
  mergedAt: Date | null;
  lastVerifiedAt: Date | null;
};

function metricSessionPrSql(): Prisma.Sql {
  return Prisma.sql`(
    al.metadata->>'linkKind' = ${SESSION_PR_LINK_KIND}
    OR (
      jsonb_typeof(al.metadata->'linkKinds') = 'array'
      AND al.metadata->'linkKinds' @> ${SESSION_PR_SET_LINK_KINDS_JSON}::jsonb
    )
  )`;
}

function canonicalSessionPrIdentitySql(): Prisma.Sql {
  const prRefs = canonicalPrRefsArraySql();
  return Prisma.sql`(
    al.metadata ? 'prRefs'
    AND jsonb_typeof(al.metadata->'prRefs') = 'array'
    AND EXISTS (
      SELECT 1
      FROM jsonb_array_elements(${prRefs}) AS pr_ref(value)
      WHERE ${prRefMatchesPullRequestSql(Prisma.sql`pr_ref.value`)}
        AND ${notProseDerivedRefSql(Prisma.sql`pr_ref.value`)}
    )
  )`;
}

function legacySessionPrIdentitySql(): Prisma.Sql {
  return Prisma.sql`(
    al.metadata->>'linkKind' = ${SESSION_PR_LINK_KIND}
    AND NOT (al.metadata ? 'prRefs')
    AND NOT ${containsSessionPrSetSql(Prisma.sql`al.metadata`)}
    AND ${legacyPrIdentityMatchesPullRequestSql()}
  )`;
}

function legacyUniqueBranchFallbackSql(): Prisma.Sql {
  return Prisma.sql`(
    al.metadata->>'linkKind' = ${SESSION_PR_LINK_KIND}
    AND NOT (al.metadata ? 'prRefs')
    AND NOT ${containsSessionPrSetSql(Prisma.sql`al.metadata`)}
    AND NOT (al.metadata ? 'repositoryFullName')
    AND NOT (al.metadata ? 'prNumber')
    AND ${uniqueBranchPullRequestSql()}
  )`;
}

function tierTwoUniqueBranchFallbackSql(organizationId: string): Prisma.Sql {
  return Prisma.sql`(
    p.repository_id IS NULL
    AND p.number IS NOT NULL
    AND ${pullRequestRepositoryNameSql()} IS NOT NULL
    AND ${uniqueBranchPullRequestSql()}
    AND EXISTS (
      SELECT 1
      FROM artifact_links branch_link
      JOIN artifacts branch_session ON branch_session.id = branch_link.source_id
      WHERE branch_link.organization_id = ${organizationId}::uuid
        AND branch_session.organization_id = ${organizationId}::uuid
        AND branch_link.target_id = p.branch_artifact_id
        AND branch_link.link_type = ${LinkType.RelatesTo}::"LinkType"
        AND branch_session.type = ${ArtifactType.Session}::"ArtifactType"
        AND (
          branch_link.branch_participation IS NULL
          OR branch_link.branch_participation = ${BranchParticipationKind.Wrote}
        )
        AND ${commandDerivedSessionBranchLinkSql()}
    )
    AND NOT EXISTS (
      SELECT 1
      FROM artifact_links prose_link
      JOIN artifacts prose_session ON prose_session.id = prose_link.source_id
      WHERE prose_link.organization_id = ${organizationId}::uuid
        AND prose_session.organization_id = ${organizationId}::uuid
        AND prose_link.target_id = p.branch_artifact_id
        AND prose_link.link_type = ${LinkType.RelatesTo}::"LinkType"
        AND prose_session.type = ${ArtifactType.Session}::"ArtifactType"
        AND ${proseSessionPrLinkSql()}
    )
  )`;
}

function uniqueBranchPullRequestSql(): Prisma.Sql {
  return Prisma.sql`(
    SELECT COUNT(*)
    FROM pull_request_detail sibling_pr
    WHERE sibling_pr.branch_artifact_id = p.branch_artifact_id
  ) = 1`;
}

function commandDerivedSessionBranchLinkSql(): Prisma.Sql {
  return Prisma.sql`${validSessionPrIdentityMetadataSql(
    BRANCH_LINK_METADATA_SQL
  )}
  AND ${validLinkMethodSql(BRANCH_LINK_METADATA_SQL)}
  AND (
    branch_link.metadata->>'linkKind' = ${SessionArtifactLinkKind.SessionBranch}
    OR COALESCE(
      jsonb_typeof(branch_link.metadata->'linkKinds') = 'array'
      AND branch_link.metadata->'linkKinds' ? ${SessionArtifactLinkKind.SessionBranch},
      FALSE
    )
  )
  AND NOT (
    COALESCE(branch_link.metadata ? 'method', FALSE)
    AND branch_link.metadata->>'method' IN (
      ${ArtifactRefMethod.PrMentionInProse},
      ${ArtifactRefMethod.BranchMentionInProse}
    )
  )`;
}

function proseSessionPrLinkSql(): Prisma.Sql {
  return Prisma.sql`(
    prose_link.metadata->>'linkKind' = ${SessionArtifactLinkKind.SessionPrProse}
    OR COALESCE(
      jsonb_typeof(prose_link.metadata->'linkKinds') = 'array'
      AND prose_link.metadata->'linkKinds' ? ${SessionArtifactLinkKind.SessionPrProse},
      FALSE
    )
  )
  AND ${proseSessionPrIdentitySql()}`;
}

function proseSessionPrIdentitySql(): Prisma.Sql {
  const prRefs = prosePrRefsArraySql();
  return Prisma.sql`(
    (
      jsonb_typeof(prose_link.metadata->'repositoryFullName') = 'string'
      AND NULLIF(BTRIM(prose_link.metadata->>'repositoryFullName'), '') IS NOT NULL
      AND jsonb_typeof(prose_link.metadata->'prNumber') = 'number'
      AND (prose_link.metadata->>'prNumber') ~ ${POSITIVE_JSON_INTEGER_PATTERN}
      AND ${repositoryIdentitySql(Prisma.sql`prose_link.metadata->>'repositoryFullName'`)} = ${pullRequestRepositoryNameSql()}
      AND prose_link.metadata->>'prNumber' = p.number::text
    )
    OR EXISTS (
      SELECT 1
      FROM jsonb_array_elements(${prRefs}) AS prose_ref(value)
      WHERE ${prRefMatchesPullRequestSql(Prisma.sql`prose_ref.value`)}
        AND (
          NOT (prose_ref.value ? 'method')
          OR prose_ref.value->>'method' IN (
            ${ArtifactRefMethod.PrMentionInProse},
            ${ArtifactRefMethod.BranchMentionInProse}
          )
        )
    )
  )`;
}

function canonicalPrRefsArraySql(): Prisma.Sql {
  return prRefsArraySql(AL_LINK_METADATA_SQL);
}

/**
 * The link's `prRefs`, as a set of rows. A missing key, a JSON `null`, and a
 * non-array value all become the empty set rather than an error, because
 * `jsonb_array_elements` raises on a non-array and every caller runs inside a
 * predicate that must answer FALSE, not fail the statement.
 */
function prRefsArraySql(metadata: Prisma.Sql): Prisma.Sql {
  return Prisma.sql`CASE
    WHEN jsonb_typeof(${metadata}->'prRefs') = 'array' THEN ${metadata}->'prRefs'
    ELSE '[]'::jsonb
  END`;
}

function prosePrRefsArraySql(): Prisma.Sql {
  return Prisma.sql`CASE
    WHEN jsonb_typeof(prose_link.metadata->'prRefs') = 'array' THEN prose_link.metadata->'prRefs'
    ELSE '[]'::jsonb
  END`;
}

/**
 * The SESSION-LINKED half of {@link orgMergedPullRequestMembershipSql}, on its
 * own, over the same `p` alias — that function is literally this predicate
 * `AND p.last_verified_at IS NOT NULL`, so the two cannot disagree about which
 * rows are candidates.
 *
 * Split out for ISS-8424: the Delivery read has to tell "this org merged no
 * session-linked pull requests" apart from "it merged some and none has been
 * verified yet", and only the second is a not-yet-measured population rather
 * than a measured zero.
 *
 * SESSION-LINKED is IDENTITY-LEVEL, per this module's own header and ISS-8426:
 * a link admits a row only when it names that row's `repo#number`. It is not
 * "any Metric link on the branch". The distinction is the whole difference
 * between the two states this census reports — a row on a session-linked
 * branch that no link NAMES is admitted by no arm of the population, so
 * verification can never move it in, and calling it evidence of a pending
 * measurement renders an em dash that no sync will ever resolve.
 */
export function sessionLinkedPullRequestMembershipSql(
  organizationId: string
): Prisma.Sql {
  return Prisma.sql`(
    EXISTS (
      SELECT 1
      FROM artifact_links al
      JOIN artifacts sa ON sa.id = al.source_id
      WHERE al.organization_id = ${organizationId}::uuid
        AND sa.organization_id = ${organizationId}::uuid
        AND al.target_id = p.branch_artifact_id
        AND al.link_type = ${LinkType.RelatesTo}::"LinkType"
        AND sa.type = ${ArtifactType.Session}::"ArtifactType"
        AND ${metricSessionPrSql()}
        AND ${validSessionPrIdentityMetadataSql(AL_LINK_METADATA_SQL)}
        AND (
          ${canonicalSessionPrIdentitySql()}
          OR ${legacySessionPrIdentitySql()}
          OR ${legacyUniqueBranchFallbackSql()}
        )
    )
    OR ${tierTwoUniqueBranchFallbackSql(organizationId)}
  )`;
}

/**
 * `sessionPrIdentityMetadataSchema`'s own field contract, over ANY link's
 * metadata expression — the ONE decision both arms of
 * {@link sessionLinkedPullRequestMembershipSql} now compose (ISS-8265 review,
 * whitlockk and codex on PR #6246).
 *
 * It was previously bound to `al.metadata` and reachable only from the
 * session→PR arm, so a session→BRANCH link whose `prRefs` is a scalar — or a
 * legacy scalar link whose `linkKinds` is not an array — was admitted HERE and
 * refused by the TypeScript mirror (`parseSessionPrLinkMetadata` /
 * `isNonProseSessionBranchLink` fail closed on exactly that metadata). The two
 * dialects then split on corrupt links: the SQL totals counted a PR the Prisma
 * scan and the Delivery rows dropped.
 *
 * `prRefs` is all-or-nothing because `z.array` fails the WHOLE array on one bad
 * element, so a link with one malformed ref declares NO identity rather than
 * its well-formed siblings' — matching a good sibling here would readmit the
 * same divergence in a new place.
 */
function validSessionPrIdentityMetadataSql(metadata: Prisma.Sql): Prisma.Sql {
  return Prisma.sql`(
    jsonb_typeof(${metadata}) = 'object'
    AND (
      NOT (${metadata} ? 'linkKind')
      OR ${metadata}->>'linkKind' IN (
        ${SessionArtifactLinkKind.SessionPr},
        ${SessionArtifactLinkKind.SessionPrProse},
        ${SessionArtifactLinkKind.SessionBranch}
      )
    )
    AND (
      NOT (${metadata} ? 'linkKinds')
      OR jsonb_typeof(${metadata}->'linkKinds') = 'array'
    )
    AND (
      NOT (${metadata} ? 'repositoryFullName')
      OR (
        jsonb_typeof(${metadata}->'repositoryFullName') = 'string'
        AND NULLIF(BTRIM(${metadata}->>'repositoryFullName'), '') IS NOT NULL
      )
    )
    AND (
      NOT (${metadata} ? 'prNumber')
      OR (
        jsonb_typeof(${metadata}->'prNumber') = 'number'
        AND (${metadata}->>'prNumber') ~ ${POSITIVE_JSON_INTEGER_PATTERN}
      )
    )
    AND (
      NOT (${metadata} ? 'relationTypes')
      OR jsonb_typeof(${metadata}->'relationTypes') = 'array'
    )
    AND (
      NOT (${metadata} ? 'prRefs')
      OR (
        jsonb_typeof(${metadata}->'prRefs') = 'array'
        AND ${validCanonicalPrRefsSql(prRefsArraySql(metadata))}
      )
    )
  )`;
}

/**
 * `sessionPrLinkMetadataSchema`'s `method` field (`z.string().min(1)`).
 *
 * Carried only by the BRANCH arm, because only that arm's TypeScript mirror
 * (`isTierTwoUniqueBranchFallbackLink` → `parseSessionPrLinkMetadata`) parses
 * the full link schema. The session→PR arms classify through
 * `sessionPrIdentityMetadataSchema`, which passes `method` through unread, so
 * asserting it there would narrow this dialect PAST its mirror — the same
 * divergence in the opposite direction.
 */
function validLinkMethodSql(metadata: Prisma.Sql): Prisma.Sql {
  return Prisma.sql`(
    NOT (${metadata} ? 'method')
    OR (
      jsonb_typeof(${metadata}->'method') = 'string'
      AND NULLIF(BTRIM(${metadata}->>'method'), '') IS NOT NULL
    )
  )`;
}

function validCanonicalPrRefsSql(prRefs: Prisma.Sql): Prisma.Sql {
  return Prisma.sql`NOT EXISTS (
    SELECT 1
    FROM jsonb_array_elements(${prRefs}) AS validation_ref(value)
    WHERE jsonb_typeof(validation_ref.value) IS DISTINCT FROM 'object'
      OR jsonb_typeof(validation_ref.value->'repositoryFullName') IS DISTINCT FROM 'string'
      OR NULLIF(BTRIM(validation_ref.value->>'repositoryFullName'), '') IS NULL
      OR jsonb_typeof(validation_ref.value->'prNumber') IS DISTINCT FROM 'number'
      OR NOT ((validation_ref.value->>'prNumber') ~ ${POSITIVE_JSON_INTEGER_PATTERN})
      OR jsonb_typeof(validation_ref.value->'relationTypes') IS DISTINCT FROM 'array'
      OR (
        validation_ref.value ? 'method'
        AND (
          jsonb_typeof(validation_ref.value->'method') IS DISTINCT FROM 'string'
          OR NULLIF(BTRIM(validation_ref.value->>'method'), '') IS NULL
        )
      )
  )`;
}

function prRefMatchesPullRequestSql(ref: Prisma.Sql): Prisma.Sql {
  return Prisma.sql`(
    ${repositoryIdentitySql(Prisma.sql`${ref}->>'repositoryFullName'`)} = ${pullRequestRepositoryNameSql()}
    AND (${ref}->>'prNumber') = p.number::text
  )`;
}

function legacyPrIdentityMatchesPullRequestSql(): Prisma.Sql {
  return Prisma.sql`(
    jsonb_typeof(al.metadata->'repositoryFullName') = 'string'
    AND NULLIF(BTRIM(al.metadata->>'repositoryFullName'), '') IS NOT NULL
    AND jsonb_typeof(al.metadata->'prNumber') = 'number'
    AND (al.metadata->>'prNumber') ~ ${POSITIVE_JSON_INTEGER_PATTERN}
    AND ${repositoryIdentitySql(Prisma.sql`al.metadata->>'repositoryFullName'`)} = ${pullRequestRepositoryNameSql()}
    AND (al.metadata->>'prNumber') = p.number::text
  )`;
}

function pullRequestRepositoryNameSql(): Prisma.Sql {
  return repositoryIdentitySql(Prisma.sql`COALESCE(
    (
      SELECT pr_repository.full_name
      FROM github_installation_repositories pr_repository
      WHERE pr_repository.id = p.repository_id
    ),
    p.repository_full_name
  )`);
}

function repositoryIdentitySql(value: Prisma.Sql): Prisma.Sql {
  return Prisma.sql`NULLIF(${normalizedRepositoryFullNameSql(value)}, '')`;
}

function normalizedRepositoryFullNameSql(value: Prisma.Sql): Prisma.Sql {
  const trimmed = slashTrimmedRepositoryFullNameSql(value);
  return Prisma.sql`LOWER(
    REGEXP_REPLACE(
      CASE
        WHEN LOWER(${trimmed}) LIKE ${GIT_SUFFIX_LIKE_PATTERN}
          THEN LEFT(${trimmed}, LENGTH(${trimmed}) - ${GIT_SUFFIX_LENGTH})
        ELSE ${trimmed}
      END,
      ${TRAILING_SLASHES_PATTERN},
      ''
    )
  )`;
}

function slashTrimmedRepositoryFullNameSql(value: Prisma.Sql): Prisma.Sql {
  return Prisma.sql`REGEXP_REPLACE(
    REGEXP_REPLACE(BTRIM(${value}), ${LEADING_SLASHES_PATTERN}, ''),
    ${TRAILING_SLASHES_PATTERN},
    ''
  )`;
}

function containsSessionPrSetSql(metadata: Prisma.Sql): Prisma.Sql {
  return Prisma.sql`COALESCE((
    jsonb_typeof(${metadata}->'linkKinds') = 'array'
    AND ${metadata}->'linkKinds' @> ${SESSION_PR_SET_LINK_KINDS_JSON}::jsonb
  ), FALSE)`;
}

function notProseDerivedRefSql(ref: Prisma.Sql): Prisma.Sql {
  return Prisma.sql`NOT (
    ${ref} ? 'method'
    AND ${ref}->>'method' IN (
      ${ArtifactRefMethod.PrMentionInProse},
      ${ArtifactRefMethod.BranchMentionInProse}
    )
  )`;
}

/** The two link-metadata expressions the shared guards above are applied to. */
const AL_LINK_METADATA_SQL = Prisma.sql`al.metadata`;
const BRANCH_LINK_METADATA_SQL = Prisma.sql`branch_link.metadata`;

const SESSION_PR_LINK_KIND = SessionArtifactLinkKind.SessionPr;
const SESSION_PR_SET_LINK_KINDS_JSON = JSON.stringify([
  SessionArtifactLinkKind.SessionPrSet,
]);
const POSITIVE_JSON_INTEGER_PATTERN = "^[1-9][0-9]*$";
const LEADING_SLASHES_PATTERN = "^/+";
const TRAILING_SLASHES_PATTERN = "/+$";
const GIT_SUFFIX_LIKE_PATTERN = "%.git";
const GIT_SUFFIX_LENGTH = 4;
