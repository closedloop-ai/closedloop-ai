import { ArtifactActivityActorType } from "@repo/api/src/types/artifact-activity";
import { DirectCollaboratorSource } from "@repo/api/src/types/artifact-collaborators";
import {
  BranchCollaboratorSource,
  BranchIdentityAvailability,
  BranchPersonProvider,
} from "@repo/api/src/types/branch-identity";
import {
  BRANCH_PUSH_SHA_PATTERN,
  BRANCH_PUSH_ZERO_SHA_PATTERN,
} from "@repo/api/src/types/branch-push-contribution";
import { ThreadSource } from "@repo/api/src/types/comment";
import { GitHubActorType } from "@repo/api/src/types/github-actor";
import { ExternalCommentProvider, Prisma } from "@repo/database";
import {
  BRANCH_CONTRIBUTOR_EVIDENCE_MAX_ROWS as BRANCH_CONTRIBUTOR_SOURCE_PAGE_LIMIT,
  BRANCH_COMMENT_EVIDENCE_MAX_ROWS as COMMENT_EVIDENCE_LIMIT,
} from "@/app/branches/branch-read-service/identity-evidence-limits";
import {
  GITHUB_GHOST_AUTHOR_PREFIX,
  GITHUB_SHADOW_CLERK_PREFIX,
} from "@/app/comments/github-shadow-identity";
import {
  branchOwnerIdentityLateralSql,
  closedloopPersonKeySql,
  displayUserNameSql,
  sessionEvidenceLinkJoinSql,
  sessionEvidenceLinkPredicateSql,
} from "../branch-read-service/branch-session-identity-sql";
import { pullRequestCommentProofIncompleteSql } from "../branch-read-service/pull-request-comment-proof-sql";
import { branchListTextCollationSql } from "./branch-list-filter-sql";

/**
 * The Postgres half of `resolveBranchIdentities`
 * (`branch-read-service/identity-attribution.ts`), so the Branches list can
 * compute its Collaborator facet in SQL instead of folding the whole corpus in
 * JavaScript.
 *
 * ISS-12775: set-based. Every evidence source is read once for the whole
 * scope, keyed and ranked per branch, instead of once per branch in a LATERAL.
 * In prod the per-branch form spent 1,488 ms of a 2,512 ms warm page statement
 * here, 317 ms of it re-resolving the verified GitHub connection once per PR
 * comment (24,371 lookups for 3,757 branches).
 *
 * Every arm binds the scope row as `a`, as the shared evidence predicates
 * (`sessionEvidenceLinkPredicateSql`, `pullRequestCommentProofIncompleteSql`)
 * expect; the scope row also carries the `branch_detail` columns and the
 * observed-push owner the arms read.
 */

/**
 * CTE definitions (no leading `WITH`) ending in `branch_collaborator_identity`:
 * `branch_id uuid`, `collaborator_keys text[]`, `collaborator_labels text[]`
 * (index-aligned), `collaborator_availability text`, one row per branch of
 * `scope`. `scope` is a SELECT whose single `id` column names BRANCH artifacts.
 */
export function branchCollaboratorIdentityCtesSql(
  scope: Prisma.Sql
): Prisma.Sql {
  return Prisma.sql`
    branch_collaborator_scope AS MATERIALIZED (
      SELECT
        a.id,
        a.organization_id,
        a.created_by_id,
        b.repository_full_name,
        b.branch_name,
        b.push_coverage_availability,
        branch_owner_identity.observed_owner_key,
        branch_owner_identity.observed_owner_label,
        branch_owner_identity.observed_owner_availability
      FROM (${scope}) scope
      INNER JOIN artifacts a ON a.id = scope.id
      INNER JOIN branch_detail b ON b.artifact_id = a.id
      ${branchOwnerIdentityLateralSql()}
    ),
    branch_collaborator_verified_connection AS MATERIALIZED (
      ${verifiedGitHubConnectionSql()}
    ),
    branch_collaborator_candidate AS MATERIALIZED (
      ${Prisma.join(
        // `projectBranchCollaborators`' candidate order, then the direct people
        // `mergeDirectArtifactPeople` appends: on a tie the JS keeps the first.
        [
          branchCommentCandidateSql(),
          sessionCommentCandidateSql(),
          githubCommentCandidateSql(),
          branchOwnerCandidateSql(),
          pullRequestAuthorLoginCandidateSql(),
          pullRequestAuthorCandidateSql(),
          pushContributionCandidateSql(),
          directArtifactCandidateSql(),
        ].map(
          (arm, armOrder) =>
            Prisma.sql`SELECT ${armOrder}::int AS arm_order, arm.* FROM (${arm}) arm`
        ),
        " UNION ALL "
      )}
    ),
    branch_collaborator_people AS (
      SELECT
        collaborator.branch_id,
        array_agg(collaborator.person_key ORDER BY collaborator.person_key ${branchListTextCollationSql()}) AS collaborator_keys,
        array_agg(collaborator.person_label ORDER BY collaborator.person_key ${branchListTextCollationSql()}) AS collaborator_labels
      FROM (
        SELECT DISTINCT ON (candidate.branch_id, candidate.person_key)
          candidate.branch_id,
          candidate.person_key,
          candidate.person_label
        FROM branch_collaborator_candidate candidate
        WHERE candidate.person_key IS NOT NULL
          AND ${candidateWithinSourceLimitSql()}
        ORDER BY
          candidate.branch_id,
          candidate.person_key,
          candidate.is_github DESC,
          candidate.provider_identity ${branchListTextCollationSql()},
          -- Two arms can name one person under one provider identity with
          -- different labels (a GitHub display name, the connected user's own
          -- name); keep the JS projector's first, not the sort's pick.
          candidate.arm_order,
          candidate.row_rank
      ) collaborator
      GROUP BY collaborator.branch_id
    ),
    branch_collaborator_tally AS (
      SELECT
        candidate.branch_id,
        ${sourceCountSql(BranchCollaboratorSource.BranchComments)} AS branch_comment_count,
        ${sourceCountSql(BranchCollaboratorSource.SessionComments)} AS session_comment_count,
        ${sourceCountSql(BranchCollaboratorSource.PullRequestComments)} AS pull_request_comment_count,
        count(*) FILTER (
          WHERE candidate.source_kind = ${BranchCollaboratorSource.Pushes}
            AND candidate.row_rank > 0
        ) AS push_count,
        bool_or(candidate.unclassified) FILTER (
          WHERE ${candidateWithinSourceLimitSql()}
        ) AS any_unclassified
      FROM branch_collaborator_candidate candidate
      GROUP BY candidate.branch_id
    ),
    branch_collaborator_identity AS (
      SELECT
        a.id AS branch_id,
        COALESCE(people.collaborator_keys, ARRAY[]::text[]) AS collaborator_keys,
        COALESCE(people.collaborator_labels, ARRAY[]::text[]) AS collaborator_labels,
        CASE
          WHEN ${collaboratorIncompleteSql()} THEN ${BranchIdentityAvailability.Incomplete}::text
          ELSE ${BranchIdentityAvailability.Complete}::text
        END AS collaborator_availability
      FROM branch_collaborator_scope a
      LEFT JOIN branch_collaborator_people people ON people.branch_id = a.id
      LEFT JOIN branch_collaborator_tally tally ON tally.branch_id = a.id
    )
  `;
}

/** Joins `branch_collaborator_identity` to a query whose FROM binds the branch as `a`. */
export function branchCollaboratorIdentityJoinSql(): Prisma.Sql {
  return Prisma.sql`
    LEFT JOIN branch_collaborator_identity
      ON branch_collaborator_identity.branch_id = a.id
  `;
}

/** `providerIdentityKey` (`branch-identity.ts:156`) for a GitHub-sourced person. */
function githubProviderIdentitySql(
  providerUserIdColumn: Prisma.Sql
): Prisma.Sql {
  return Prisma.sql`(${BranchPersonProvider.GitHub}::text || ':' || ${providerUserIdColumn})`;
}

/**
 * The per-branch evidence cap the JS names `COMMENT_EVIDENCE_LIMIT` in
 * `branch-read-service/page-comment-evidence.ts`, where `githubCapped` and its
 * sibling flags mark a branch over it.
 */
function commentRowRankSql(orderBy: Prisma.Sql): Prisma.Sql {
  return Prisma.sql`ROW_NUMBER() OVER (PARTITION BY a.id ORDER BY ${orderBy})`;
}

function sourceCountSql(source: BranchCollaboratorSource): Prisma.Sql {
  return Prisma.sql`count(*) FILTER (WHERE candidate.source_kind = ${source})`;
}

function platformCommentCandidateColumnsSql(source: string): Prisma.Sql {
  const human = Prisma.sql`(
    u.id IS NOT NULL
    AND u.clerk_id NOT LIKE ${`${GITHUB_SHADOW_CLERK_PREFIX}%`}
  )`;
  return Prisma.sql`
    a.id AS branch_id,
    ${source}::text AS source_kind,
    ${commentRowRankSql(Prisma.sql`c.created_at ASC, c.id ASC`)} AS row_rank,
    (CASE WHEN ${human} THEN ${closedloopPersonKeySql(Prisma.sql`u.id`)} END) AS person_key,
    (CASE WHEN ${human} THEN ${displayUserNameSql()} END) AS person_label,
    FALSE AS is_github,
    (CASE WHEN ${human} THEN ${closedloopPersonKeySql(Prisma.sql`u.id`)} END) AS provider_identity,
    (NOT COALESCE(${human}, FALSE)) AS unclassified
  `;
}

/** Native and Liveblocks comments on the threads of `threadArtifactId`. */
function platformCommentJoinSql(threadArtifactId: Prisma.Sql): Prisma.Sql {
  return Prisma.sql`
    INNER JOIN comment_threads t
      ON t.organization_id = a.organization_id
      AND t.artifact_id = ${threadArtifactId}
      AND t.source IN (
        ${ThreadSource.Native}::"ThreadSource",
        ${ThreadSource.Liveblocks}::"ThreadSource"
      )
    INNER JOIN comments c
      ON c.thread_id = t.id
      AND c.deleted_at IS NULL
    LEFT JOIN users u
      ON u.organization_id = a.organization_id
      AND u.id = c.author_id
  `;
}

function branchCommentCandidateSql(): Prisma.Sql {
  return Prisma.sql`
    SELECT
      ${platformCommentCandidateColumnsSql(BranchCollaboratorSource.BranchComments)}
    FROM branch_collaborator_scope a
    ${platformCommentJoinSql(Prisma.sql`a.id`)}
  `;
}

/** DISTINCT keeps a session linked twice from counting its comments twice. */
function sessionCommentCandidateSql(): Prisma.Sql {
  return Prisma.sql`
    SELECT
      ${platformCommentCandidateColumnsSql(BranchCollaboratorSource.SessionComments)}
    FROM branch_collaborator_scope a
    CROSS JOIN LATERAL (
      SELECT DISTINCT al.source_id
      ${sessionEvidenceLinkJoinSql()}
      WHERE ${sessionEvidenceLinkPredicateSql()}
    ) linked_session
    ${platformCommentJoinSql(Prisma.sql`linked_session.source_id`)}
  `;
}

function githubActorTypeSql(): Prisma.Sql {
  return Prisma.sql`(eca.provider_detail ->> 'actorType')`;
}

function githubHumanActorSql(): Prisma.Sql {
  return Prisma.sql`(${humanActorTypeSql(githubActorTypeSql())} AND eca.provider_user_id NOT LIKE ${`${GITHUB_GHOST_AUTHOR_PREFIX}%`})`;
}

function humanActorTypeSql(actorType: Prisma.Sql): Prisma.Sql {
  return Prisma.sql`(${actorType} IN (
    ${GitHubActorType.User},
    ${GitHubActorType.Mannequin},
    ${GitHubActorType.EnterpriseUserAccount}
  ))`;
}

function unclassifiedActorTypeSql(
  actorType: Prisma.Sql,
  providerUserId: Prisma.Sql
): Prisma.Sql {
  return Prisma.sql`(NOT COALESCE(
    (${humanActorTypeSql(actorType)} AND ${providerUserId} ~ '^[0-9]+$')
    OR ${actorType} = ${GitHubActorType.Bot},
    FALSE
  ))`;
}

/**
 * `projectBranchPeople` (`branch-identity.ts:83`) drops a Bot SILENTLY and
 * flags every other non-human actor, including an absent one and a
 * `provider_detail` that is not a JSON object — both of which land here as a
 * NULL `actorType`.
 */
function githubUnclassifiedSql(): Prisma.Sql {
  return Prisma.sql`(NOT COALESCE(
    ${githubHumanActorSql()}
    OR ${githubActorTypeSql()} = ${GitHubActorType.Bot},
    FALSE
  ))`;
}

/**
 * `github_comment_projections` carries no `organization_id`, so its
 * `external_author_id` FK cannot be composite and nothing at the database layer
 * stops it pointing at another tenant's author row. The org predicate therefore
 * belongs on this read (`apps/api/AGENTS.md` — a projection reused by remote
 * provider identity scopes through the owning organization in the query). It
 * sits in the ON clause, not the WHERE: a foreign-org author must fall to a NULL
 * `eca` — unresolved, hence `unclassified`, hence an Incomplete availability —
 * and not drop the evidence row, which is what moving it to WHERE would do.
 */
function githubCommentCandidateSql(): Prisma.Sql {
  return Prisma.sql`
    SELECT
      a.id AS branch_id,
      ${BranchCollaboratorSource.PullRequestComments}::text AS source_kind,
      ${commentRowRankSql(
        Prisma.sql`c.created_at ASC, gcp.comment_id ASC`
      )} AS row_rank,
      (CASE WHEN ${githubHumanActorSql()} THEN ${closedloopPersonKeySql(resolvedGitHubUserIdSql())} END) AS person_key,
      (CASE WHEN ${githubHumanActorSql()} THEN COALESCE(eca.display_name, eca.provider_login) END) AS person_label,
      TRUE AS is_github,
      (CASE WHEN ${githubHumanActorSql()} THEN ${githubProviderIdentitySql(Prisma.sql`eca.provider_user_id`)} END) AS provider_identity,
      ${githubUnclassifiedSql()} AS unclassified
    FROM branch_collaborator_scope a
    INNER JOIN github_comment_thread_projections tp
      ON tp.branch_artifact_id = a.id
      AND tp.deleted_at IS NULL
    INNER JOIN pull_request_detail pr
      ON pr.id = tp.pull_request_detail_id
      AND pr.branch_artifact_id = a.id
      AND pr.organization_id = a.organization_id
    INNER JOIN github_comment_projections gcp
      ON gcp.thread_id = tp.thread_id
      AND gcp.github_deleted_at IS NULL
    INNER JOIN comments c
      ON c.thread_id = gcp.thread_id
      AND c.id = gcp.comment_id
      AND c.deleted_at IS NULL
    INNER JOIN comment_threads t
      ON t.id = c.thread_id AND t.organization_id = a.organization_id
    LEFT JOIN external_comment_authors eca
      ON eca.id = gcp.external_author_id
      AND eca.organization_id = a.organization_id
    ${verifiedGitHubConnectionJoinSql(Prisma.sql`eca.provider_user_id`)}
  `;
}

function pullRequestAuthorCandidateSql(): Prisma.Sql {
  const actorType = Prisma.sql`pr.author_actor_type`;
  const providerUserId = Prisma.sql`pr.author_provider_user_id`;
  const ghost = Prisma.sql`(pr.author_login = 'ghost' OR eca.provider_login = 'ghost')`;
  const qualified = Prisma.sql`(${humanActorTypeSql(actorType)} AND ${providerUserId} ~ '^[0-9]+$' AND NOT COALESCE(${ghost}, FALSE))`;
  return Prisma.sql`
    SELECT
      a.id AS branch_id,
      ${BranchCollaboratorSource.PullRequestAuthors}::text AS source_kind,
      ${pullRequestRowRankSql()} AS row_rank,
      (CASE WHEN ${qualified} THEN COALESCE(
        ${closedloopPersonKeySql(resolvedGitHubUserIdSql())},
        ${githubProviderIdentitySql(providerUserId)}
      ) END) AS person_key,
      (CASE WHEN ${qualified} THEN COALESCE(
        eca.display_name, eca.provider_login, pr.author_login,
        pr.author_provider_user_id
      ) END) AS person_label,
      TRUE AS is_github,
      (CASE WHEN ${qualified} THEN ${githubProviderIdentitySql(providerUserId)} END) AS provider_identity,
      (${unclassifiedActorTypeSql(actorType, providerUserId)} OR COALESCE(${ghost}, FALSE)) AS unclassified
    FROM branch_collaborator_scope a
    INNER JOIN pull_request_detail pr
      ON pr.organization_id = a.organization_id
      AND pr.branch_artifact_id = a.id
    LEFT JOIN external_comment_authors eca
      ON eca.organization_id = a.organization_id
      AND eca.provider = ${ExternalCommentProvider.GITHUB}::"ExternalCommentProvider"
      AND eca.provider_user_id = pr.author_provider_user_id
    ${verifiedGitHubConnectionJoinSql(providerUserId)}
  `;
}

function pullRequestAuthorLoginCandidateSql(): Prisma.Sql {
  const providerIdentity =
    githubProviderIdentitySql(Prisma.sql`gc.github_user_id`);
  return Prisma.sql`
    SELECT
      a.id AS branch_id,
      ${BranchCollaboratorSource.PullRequestAuthors}::text AS source_kind,
      ${pullRequestRowRankSql()} AS row_rank,
      ${closedloopPersonKeySql(Prisma.sql`gc.user_id`)} AS person_key,
      COALESCE(${displayUserNameSql()}, gc.login) AS person_label,
      TRUE AS is_github,
      ${providerIdentity} AS provider_identity,
      FALSE AS unclassified
    FROM branch_collaborator_scope a
    INNER JOIN pull_request_detail pr
      ON pr.organization_id = a.organization_id
      AND pr.branch_artifact_id = a.id
    INNER JOIN github_user_connections gc
      ON gc.organization_id = a.organization_id
      AND gc.login = pr.author_login
      AND gc.revoked_at IS NULL
    LEFT JOIN users u
      ON u.organization_id = a.organization_id
      AND u.id = gc.user_id
    WHERE pr.author_login IS NOT NULL
      AND pr.author_login <> ''
      AND pr.author_login <> 'ghost'
  `;
}

function pullRequestRowRankSql(): Prisma.Sql {
  return commentRowRankSql(
    Prisma.sql`
      pr.repository_full_name ASC,
      pr.repository_id ASC,
      pr.number ASC,
      pr.id ASC
    `
  );
}

function pushContributionCandidateSql(): Prisma.Sql {
  const actorType = Prisma.sql`p.actor_type`;
  const providerUserId = Prisma.sql`p.provider_user_id`;
  const qualified = Prisma.sql`(
    ${humanActorTypeSql(actorType)}
    AND ${providerUserId} ~ '^[0-9]+$'
    AND ${validPushTransitionSql()}
  )`;
  return Prisma.sql`
    SELECT
      a.id AS branch_id,
      ${BranchCollaboratorSource.Pushes}::text AS source_kind,
      ${commentRowRankSql(Prisma.sql`p.observed_at ASC, p.id ASC`)} AS row_rank,
      (CASE WHEN ${qualified} THEN COALESCE(
        ${closedloopPersonKeySql(resolvedGitHubUserIdSql())},
        ${githubProviderIdentitySql(providerUserId)}
      ) END) AS person_key,
      (CASE WHEN ${qualified} THEN COALESCE(
        eca.display_name, eca.provider_login, p.provider_user_id
      ) END) AS person_label,
      TRUE AS is_github,
      (CASE WHEN ${qualified} THEN ${githubProviderIdentitySql(providerUserId)} END) AS provider_identity,
      (${unclassifiedActorTypeSql(actorType, providerUserId)}
        OR NOT ${validPushTransitionSql()}) AS unclassified
    FROM branch_collaborator_scope a
    CROSS JOIN LATERAL (
      SELECT receipt.* FROM branch_push_contributions receipt
      WHERE receipt.organization_id = a.organization_id
        AND receipt.branch_artifact_id = a.id
        AND receipt.repository_full_name = a.repository_full_name
        AND receipt.ref_name = a.branch_name
      ORDER BY receipt.observed_at ASC, receipt.id ASC
      LIMIT ${BRANCH_CONTRIBUTOR_SOURCE_PAGE_LIMIT + 1}
    ) p
    LEFT JOIN external_comment_authors eca
      ON eca.organization_id = a.organization_id
      AND eca.provider = ${ExternalCommentProvider.GITHUB}::"ExternalCommentProvider"
      AND eca.provider_user_id = p.provider_user_id
    ${verifiedGitHubConnectionJoinSql(providerUserId)}
  `;
}

function validPushTransitionSql(): Prisma.Sql {
  return Prisma.sql`(
    p.before_sha ~* ${BRANCH_PUSH_SHA_PATTERN}
    AND p.after_sha ~* ${BRANCH_PUSH_SHA_PATTERN}
    AND p.after_sha !~ ${BRANCH_PUSH_ZERO_SHA_PATTERN}
    AND lower(p.before_sha) <> lower(p.after_sha)
  )`;
}

function candidateWithinSourceLimitSql(): Prisma.Sql {
  return Prisma.sql`candidate.row_rank <= (
    CASE
      WHEN candidate.source_kind IN (
        ${BranchCollaboratorSource.PullRequestAuthors},
        ${BranchCollaboratorSource.Pushes}
      ) THEN ${BRANCH_CONTRIBUTOR_SOURCE_PAGE_LIMIT}::bigint
      ELSE ${COMMENT_EVIDENCE_LIMIT}::bigint
    END
  )`;
}

function branchOwnerCandidateSql(): Prisma.Sql {
  const human = Prisma.sql`(
    owner_user.clerk_id NOT LIKE ${`${GITHUB_SHADOW_CLERK_PREFIX}%`}
  )`;
  return Prisma.sql`
    SELECT
      a.id AS branch_id,
      ${BranchCollaboratorSource.Pushes}::text AS source_kind,
      0::bigint AS row_rank,
      (CASE WHEN ${human} THEN a.observed_owner_key END) AS person_key,
      (CASE WHEN ${human} THEN a.observed_owner_label END) AS person_label,
      FALSE AS is_github,
      (CASE WHEN ${human} THEN a.observed_owner_key END) AS provider_identity,
      (NOT COALESCE(${human}, FALSE)) AS unclassified
    FROM branch_collaborator_scope a
    INNER JOIN users owner_user
      ON owner_user.organization_id = a.organization_id
      AND ${closedloopPersonKeySql(Prisma.sql`owner_user.id`)} = a.observed_owner_key
  `;
}

/**
 * PR comments are incomplete until every associated PR holds complete lane
 * proof, or when their stored rows pass the evidence cap. Push history needs its
 * own positive coverage, even with known people.
 */
function collaboratorIncompleteSql(): Prisma.Sql {
  return Prisma.sql`(
    ${pullRequestCommentIncompleteSql()}
    OR a.observed_owner_availability = ${BranchIdentityAvailability.Incomplete}
    OR COALESCE(
      a.push_coverage_availability,
      ${BranchIdentityAvailability.Incomplete}
    ) <> ${BranchIdentityAvailability.Complete}
    OR EXISTS (
      SELECT 1 FROM branch_push_contributions p
      WHERE p.organization_id = a.organization_id
        AND p.branch_artifact_id = a.id
        AND (
          p.repository_full_name <> a.repository_full_name
          OR p.ref_name <> a.branch_name
        )
    )
    OR COALESCE(tally.branch_comment_count, 0) > ${COMMENT_EVIDENCE_LIMIT}
    OR COALESCE(tally.session_comment_count, 0) > ${COMMENT_EVIDENCE_LIMIT}
    OR COALESCE(tally.pull_request_comment_count, 0) > ${COMMENT_EVIDENCE_LIMIT}
    OR (
      SELECT count(*) FROM pull_request_detail pr
      WHERE pr.organization_id = a.organization_id
        AND pr.branch_artifact_id = a.id
    ) > ${BRANCH_CONTRIBUTOR_SOURCE_PAGE_LIMIT}
    OR COALESCE(tally.push_count, 0) > ${BRANCH_CONTRIBUTOR_SOURCE_PAGE_LIMIT}
    OR COALESCE(tally.any_unclassified, FALSE)
  )`;
}

function resolvedGitHubUserIdSql(): Prisma.Sql {
  return Prisma.sql`COALESCE(verified_connection.user_id, eca.user_id)`;
}

/**
 * The current verified link per GitHub identity, resolved once for the scope's
 * organizations rather than once per evidence row: `user_id` is the one active
 * user behind every unrevoked connection carrying that identity, NULL when they
 * disagree. A connection carries its `github_user_id` and, as `node:<id>`, its
 * `github_node_id`.
 */
function verifiedGitHubConnectionSql(): Prisma.Sql {
  return Prisma.sql`
    SELECT
      connection.organization_id,
      connection_identity.provider_user_id,
      CASE WHEN count(DISTINCT connection.user_id) = 1
        THEN min(connection.user_id::text)::uuid END AS user_id
    FROM github_user_connections connection
    CROSS JOIN LATERAL (
      VALUES
        (connection.github_user_id),
        ('node:' || connection.github_node_id)
    ) connection_identity(provider_user_id)
    WHERE connection.organization_id IN (
        SELECT scope.organization_id FROM branch_collaborator_scope scope
      )
      AND connection_identity.provider_user_id IS NOT NULL
      AND connection.revoked_at IS NULL
      AND EXISTS (
        SELECT 1 FROM users verified_user
        WHERE verified_user.id = connection.user_id
          AND verified_user.organization_id = connection.organization_id
          AND verified_user.active = TRUE
      )
    GROUP BY connection.organization_id, connection_identity.provider_user_id
  `;
}

function verifiedGitHubConnectionJoinSql(
  providerUserId: Prisma.Sql
): Prisma.Sql {
  return Prisma.sql`
    LEFT JOIN branch_collaborator_verified_connection verified_connection
      ON verified_connection.organization_id = a.organization_id
      AND verified_connection.provider_user_id = ${providerUserId}
  `;
}

function pullRequestCommentIncompleteSql(): Prisma.Sql {
  return pullRequestCommentProofIncompleteSql({
    organizationId: Prisma.sql`a.organization_id`,
    branchId: Prisma.sql`a.id`,
  });
}

/** Shared direct people have no per-source truncation; Branch-specific lanes retain their caps. */
function directArtifactCandidateSql(): Prisma.Sql {
  const human = Prisma.sql`(u.id IS NOT NULL AND u.clerk_id NOT LIKE ${`${GITHUB_SHADOW_CLERK_PREFIX}%`})`;
  return Prisma.sql`
    SELECT direct.branch_id, direct.source_kind, 0::bigint AS row_rank,
      CASE WHEN ${human} THEN ${closedloopPersonKeySql(Prisma.sql`u.id`)} END AS person_key,
      CASE WHEN ${human} THEN ${displayUserNameSql()} END AS person_label,
      FALSE AS is_github,
      CASE WHEN ${human} THEN ${closedloopPersonKeySql(Prisma.sql`u.id`)} END AS provider_identity,
      NOT COALESCE(${human}, FALSE) AS unclassified
    FROM (
      SELECT a.id AS branch_id, a.organization_id, ${DirectCollaboratorSource.Creator}::text AS source_kind, a.created_by_id::text AS actor_id
        FROM branch_collaborator_scope a WHERE a.created_by_id IS NOT NULL
      UNION
      SELECT a.id, a.organization_id, ${DirectCollaboratorSource.Interactions}::text, e.actor_id
        FROM branch_collaborator_scope a
        INNER JOIN artifact_activity_events e
          ON e.organization_id = a.organization_id AND e.artifact_id = a.id
        WHERE e.actor_type IN (${ArtifactActivityActorType.User}, ${ArtifactActivityActorType.Agent}) AND e.actor_id IS NOT NULL
      UNION
      SELECT a.id, a.organization_id, ${DirectCollaboratorSource.Comments}::text, c.author_id::text
        FROM branch_collaborator_scope a
        INNER JOIN comment_threads t
          ON t.organization_id = a.organization_id AND t.artifact_id = a.id
          AND t.source IN (${ThreadSource.Native}::"ThreadSource", ${ThreadSource.Liveblocks}::"ThreadSource")
        INNER JOIN comments c ON c.thread_id = t.id AND c.deleted_at IS NULL
    ) direct
    LEFT JOIN users u ON u.id::text = direct.actor_id AND u.organization_id = direct.organization_id
  `;
}
