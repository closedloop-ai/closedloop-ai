import { ArtifactType } from "@repo/api/src/types/artifact";
import { BranchPersonProvider } from "@repo/api/src/types/branch-identity";
import { Prisma } from "@repo/database";
import { GITHUB_SHADOW_CLERK_PREFIX } from "@/app/comments/github-shadow-identity";
import {
  closedloopPersonKeySql,
  observedPushOwnerSql,
} from "../branch-read-service/branch-session-identity-sql";

/**
 * The SQL the branch assignee is seeded from (ISS-12463, PLN-2192): the Owner
 * chain — the observed-push rung, then the inferred rungs (earliest commit
 * author, then PR creator) — resolved per branch to the seeded user by
 * `branchOwnerSeedOwnerLateralSql`, which `seedBranchOwners` stamps from, and
 * the `(id, user_id)` candidate set over it that `seedBranchOwnersForLogin`
 * pages and the `iss12463_branch_owner_backfill` migration stamp from. The
 * migration inlines this candidate set with literals, pinned to it by result
 * in `iss12463-branch-owner-backfill.integration.test.ts`.
 */

/**
 * The inferred rungs — ISS-11765, ISS-11762, ISS-11752.
 *
 * Rung order: earliest commit author, then PR creator. `person_key` breaks a
 * tie WITHIN a rung — two connections sharing one `login` are not barred by the
 * schema, and the seeded person must not depend on physical row order.
 *
 * Reached only when rung 1 named nobody (the `ON observed_push.owner_key IS
 * NULL` join qual in {@link branchOwnerChainLateralSql}), so a captured push
 * always outranks an inference.
 */
function inferredOwnerSql(): Prisma.Sql {
  return Prisma.sql`
    SELECT inferred_candidate.person_key AS owner_key
    FROM (
      (${commitAuthorOwnerSql()})
      UNION ALL
      (${pullRequestAuthorOwnerSql()})
    ) inferred_candidate
    ORDER BY inferred_candidate.rung ASC, inferred_candidate.person_key ASC
    LIMIT 1
  `;
}

function inferredOwnerPersonSql(rung: number): Prisma.Sql {
  return Prisma.sql`
    ${rung}::int AS rung,
    ${closedloopPersonKeySql(Prisma.sql`gc.user_id`)} AS person_key
  `;
}

function inferredOwnerConnectionJoinSql(loginColumn: Prisma.Sql): Prisma.Sql {
  return Prisma.sql`
    INNER JOIN github_user_connections gc
      ON gc.organization_id = a.organization_id
      AND gc.login = ${loginColumn}
  `;
}

/**
 * Rung 2 — the branch's earliest commit author (ISS-11762).
 *
 * Ordered `committed_at ASC NULLS LAST, sha ASC`: an undated commit must not
 * win "earliest" by Postgres's default NULLS FIRST, but still wins as a
 * branch's only commit; `sha` settles a shared instant. The `<> ''` guard is
 * ISS-8155 — the empty string is the ABSENT form of a login, never an account.
 * Org scope runs through the branch Artifact this lateral is already
 * correlated to, NOT through `commit_detail.organization_id`, which PRD-510 D4
 * declares is not a query-scoping column.
 *
 * The login is picked BEFORE the connection is resolved: an earliest commit
 * whose author this org has no connection for does not hand the rung to the
 * second-earliest commit, it hands it to the PR creator.
 */
function commitAuthorOwnerSql(): Prisma.Sql {
  return Prisma.sql`
    SELECT
      ${inferredOwnerPersonSql(1)}
    FROM (
      SELECT commits.author_login
      FROM commit_detail commits
      WHERE commits.branch_artifact_id = a.id
        AND commits.author_login IS NOT NULL
        AND commits.author_login <> ''
      ORDER BY commits.committed_at ASC NULLS LAST, commits.sha ASC
      LIMIT 1
    ) earliest_commit
    ${inferredOwnerConnectionJoinSql(Prisma.sql`earliest_commit.author_login`)}
  `;
}

/**
 * Rung 3 — the PR creator (ISS-11752).
 *
 * PRs are taken in the branch read's own PR order
 * (`branchPullRequestDetailOrderBy` in `branch-read-selects.ts`: repository
 * full name, repository id, number, id, all ascending), empty logins dropped,
 * and the FIRST that resolves to a connection wins — so the INNER JOIN, not a
 * resolve-after-LIMIT, is the shape here: an unresolvable first PR author falls
 * through to the next PR, where an unresolvable earliest COMMIT author does not
 * fall through to the next commit.
 *
 * No COLLATE on the text keys: Prisma's `orderBy` sorts by the column's own
 * collation, so the default one is what this order has to match.
 */
function pullRequestAuthorOwnerSql(): Prisma.Sql {
  return Prisma.sql`
    SELECT
      ${inferredOwnerPersonSql(2)}
    FROM pull_request_detail pr
    ${inferredOwnerConnectionJoinSql(Prisma.sql`pr.author_login`)}
    WHERE pr.organization_id = a.organization_id
      AND pr.branch_artifact_id = a.id
      AND pr.author_login IS NOT NULL
      AND pr.author_login <> ''
    ORDER BY
      pr.repository_full_name ASC,
      pr.repository_id ASC,
      pr.number ASC,
      pr.id ASC
    LIMIT 1
  `;
}

/**
 * The whole Owner chain over `a`/`b` as `branch_owner_chain.owner_key`: the
 * observed-push rung, then the inferred rungs only when it named nobody.
 *
 * One LATERAL, so the seed's `users` join is keyed on its single output
 * column. Hoisting the inferred join into the outer query let the planner pick
 * a far slower plan (measured on `seedBranchOwnersForLogin`'s one-page case).
 */
export function branchOwnerChainLateralSql(): Prisma.Sql {
  return Prisma.sql`
    LEFT JOIN LATERAL (
      SELECT COALESCE(observed_push.owner_key, inferred.owner_key) AS owner_key
      FROM (${observedPushOwnerSql()}) observed_push
      LEFT JOIN LATERAL (${inferredOwnerSql()}) inferred
        ON observed_push.owner_key IS NULL
    ) branch_owner_chain ON TRUE
  `;
}

/**
 * `(id, user_id)` for every unassigned BRANCH matching `scope` whose Owner
 * chain resolves to a non-shadow user of the branch's organization. `scope`
 * binds the branch as `a`.
 */
export function branchOwnerSeedCandidateSql(scope: Prisma.Sql): Prisma.Sql {
  return Prisma.sql`
    SELECT a.id, branch_owner.user_id
    FROM artifacts a
    ${branchOwnerSeedOwnerLateralSql()}
    WHERE a.type = ${ArtifactType.Branch}::"ArtifactType"
      AND a.assignee_id IS NULL
      AND ${scope}
  `;
}

/**
 * The user the Owner chain seeds for the branch bound as `a` (its `id` and
 * `organization_id`), as `branch_owner.user_id`; no row when the chain names
 * nobody or names someone other than a non-shadow user of that organization.
 *
 * Both `OFFSET 0`s are optimization fences, and they are what keeps a page of
 * branches linear (ISS-12463 C6). Unfenced, the planner flattens these joins
 * into the outer query; under stale statistics that put a large organization
 * at one row (a new org, a bulk import) it then scanned the whole
 * organization's `artifacts`/`branch_detail` rows once per branch instead of
 * looking each one up by id, quadratic in the page and past the interactive
 * transaction timeout at 500 branches. Fenced, the subquery runs once per
 * branch with `b` filtered by that branch's id and `users` restricted to its
 * primary key; this removed the measured 8-30 s plans. The fence does not
 * pin `b`'s access path: with statistics taken on empty tables the planner
 * was measured reading `b` through an org index with an `artifact_id` filter
 * (400 loops x 400 rows), still fast at that size but not a by-id lookup.
 */
export function branchOwnerSeedOwnerLateralSql(): Prisma.Sql {
  return Prisma.sql`
    CROSS JOIN LATERAL (
      SELECT u.id AS user_id
      FROM branch_detail b
      ${branchOwnerChainLateralSql()}
      CROSS JOIN LATERAL (
        SELECT owner_user.id, owner_user.organization_id, owner_user.clerk_id
        FROM users owner_user
        WHERE owner_user.id = CASE
          WHEN starts_with(branch_owner_chain.owner_key, ${`${BranchPersonProvider.ClosedLoop}:`})
            THEN split_part(branch_owner_chain.owner_key, ':', 2)::uuid
        END
        OFFSET 0
      ) u
      WHERE b.artifact_id = a.id
        AND b.organization_id = a.organization_id
        AND u.organization_id = a.organization_id
        AND u.clerk_id NOT LIKE ${`${GITHUB_SHADOW_CLERK_PREFIX}%`}
      OFFSET 0
    ) branch_owner
  `;
}
