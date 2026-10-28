import { GitHubPRState } from "@repo/api/src/types/github";
import { Prisma } from "@repo/database";
import {
  normalizedRepositoryFullNameSql,
  repositoryOwnedByArtifactOrganizationSql,
} from "./branch-repository-name-sql";

/**
 * In-database twin of `selectBranchAssociatedPullRequests`
 * (`packages/api/src/types/branch-associated-pull-request.ts`). The surrounding
 * query owns aliases `a` (Artifact) and `b` (BranchDetail).
 *
 * The two MUST move together: this one decides which rows a status filter, a
 * search predicate and the Branch list facets admit; the TypeScript one decides
 * which pull request the response projection selects. ISS-10298 made the twin
 * faithful, because the list's Status and Pull-request facet counts are now
 * computed here rather than folded in JavaScript over projected rows — a row
 * counted under one status while its own card renders another is the defect
 * that forces the agreement.
 *
 * Three divergences this closed:
 *
 * 1. NO duplicate-snapshot grouping at all. The TypeScript groups candidates by
 *    `(normalized repositoryFullName, number)` and drops a whole group as
 *    `ConflictingDuplicate`; this ranked rows individually and settled ties on
 *    `id`, so a branch carrying two snapshots of one PR selected one of them
 *    where the projection selected nothing.
 * 2. `InvalidIdentity` was `number <= 0 OR full_name IS NULL`, where the
 *    TypeScript runs `parseRepositoryFullName` and rejects anything that is not
 *    exactly two non-empty segments — `owner/repo/extra` was kept here, dropped
 *    there.
 * 3. The repository-identity chain omitted the BRANCH's own repository
 *    relation, which `selectedPullRequestRepositoryFullName` reads third.
 *
 * `compareSnapshotRecency`'s `JSON.stringify(item)` tiebreak is deliberately
 * NOT reproduced — it has no honest Postgres equivalent. It is reachable only
 * between snapshots whose observation instants tie, and a tie that is not
 * lifecycle-equivalent is already dropped as a conflict, so it can only reorder
 * snapshots that agree on every lifecycle field and cannot move `state`,
 * `isDraft`, `number` or the selection. `id` is the tiebreak here instead.
 */
export function selectedAssociatedPullRequestExists(
  extraPredicates: Prisma.Sql[] = []
): Prisma.Sql {
  return Prisma.sql`EXISTS (
    SELECT 1
    FROM (${branchSelectedPullRequestSql()}) pr
    ${
      extraPredicates.length > 0
        ? Prisma.sql`WHERE ${Prisma.join(extraPredicates, " AND ")}`
        : Prisma.empty
    }
  )`;
}

/**
 * The selected pull request exists AND somebody observed it.
 *
 * ISS-8422 lets the selector fall back to an unwitnessed PR so the branch keeps
 * its number and its link, but the projection derives that branch as having NO
 * connected PR (`statusForSelectedCloudPullRequest`). A status filter reading
 * the bare selection would file the row under a status its own card does not
 * show: a merged artifact whose only PR is a factless stub renders Merged,
 * while the Merged filter rejected it and the Open filter took it (davetho
 * review on #6313).
 */
export function selectedObservedAssociatedPullRequestExists(
  extraPredicates: Prisma.Sql[] = []
): Prisma.Sql {
  return selectedAssociatedPullRequestExists([
    Prisma.sql`pr.observed`,
    ...extraPredicates,
  ]);
}

/**
 * The branch's selected pull request as an at-most-one-row correlated relation.
 *
 * Columns: `id`, `number`, `repository_full_name` (the normalized identity),
 * `pr_state` (the RESOLVED lifecycle, so a row carrying `merged_at` reads
 * MERGED whatever its column says), `is_draft`, `merged_at`, `closed_at`,
 * `review_decision`, `title`, `html_url`, `observed`.
 */
export function branchSelectedPullRequestSql(): Prisma.Sql {
  return Prisma.sql`
    ${branchPullRequestSelectionCtesSql()}
    ${branchSelectedPullRequestBodySql()}
  `;
}

/**
 * The selected pull request AND the associated count, resolved from ONE pass of
 * the snapshot chain, as a `LEFT JOIN LATERAL (…) selected_pull_request ON TRUE`
 * body. Always yields exactly one row, with every selected-PR column NULL when
 * nothing is selected, so a branch with no pull request survives the join.
 *
 * `associated_count` is `summarizeAssociatedPullRequests().associatedCount`:
 * distinct VALID, non-conflicting identities. Deliberately NOT gated on
 * ownership and NOT emptied by a selection-blocking reason — `collection.items`
 * survives both, and the list's "has a pull request" facet reads this count
 * beside the selected number.
 */
export function branchSelectedPullRequestLateralSql(): Prisma.Sql {
  return Prisma.sql`
    ${branchPullRequestSelectionCtesSql()}
    SELECT
      selected.id,
      selected.number,
      selected.repository_full_name,
      selected.pr_state,
      selected.is_draft,
      selected.merged_at,
      selected.closed_at,
      selected.review_decision,
      selected.title,
      selected.html_url,
      selected.additions,
      selected.deletions,
      COALESCE(selected.observed, FALSE) AS observed,
      (SELECT COUNT(*)::int FROM resolved) AS associated_count
    FROM (SELECT 1) one
    LEFT JOIN LATERAL (${branchSelectedPullRequestBodySql()}) selected ON TRUE
  `;
}

/**
 * Snapshots → validated → grouped by identity → resolved, in one chain.
 *
 * `MATERIALIZED` on the snapshot scan because every stage below reads it and
 * the planner would otherwise re-run the correlated scan per reference.
 */
function branchPullRequestSelectionCtesSql(): Prisma.Sql {
  return Prisma.sql`
    WITH snapshot AS MATERIALIZED (
      SELECT
        prd.id,
        prd.number,
        ${branchPullRequestRepositoryIdentitySql()} AS repository_full_name,
        prd.repository_id,
        ${pullRequestRepositoryGithubIdSql()} AS repository_github_id,
        CASE
          WHEN prd.merged_at IS NOT NULL
            THEN ${GitHubPRState.Merged}::"GitHubPRState"
          ELSE prd.pr_state
        END AS pr_state,
        prd.is_draft,
        prd.merged_at,
        prd.closed_at,
        prd.github_created_at,
        prd.review_decision,
        prd.title,
        prd.html_url,
        prd.additions,
        prd.deletions,
        prd.last_verified_at,
        ${observedPullRequestEvidenceSql()} AS observed,
        ${invalidPullRequestIdentitySql()} AS invalid_identity,
        ${invalidPullRequestLifecycleSql()} AS invalid_lifecycle
      FROM pull_request_detail prd
      LEFT JOIN github_installation_repositories prd_repository
        ON prd_repository.id = prd.repository_id
        AND ${repositoryOwnedByArtifactOrganizationSql(Prisma.sql`prd_repository`)}
      LEFT JOIN github_installation_repositories branch_repository
        ON branch_repository.id = b.repository_id
        AND ${repositoryOwnedByArtifactOrganizationSql(Prisma.sql`branch_repository`)}
      WHERE prd.branch_artifact_id = a.id
    ),
    ranked AS (
      SELECT
        snapshot.*,
        row_number() OVER recency AS recency_rank,
        first_value(snapshot.id) OVER recency AS newest_id,
        first_value(snapshot.last_verified_at) OVER recency
          AS newest_last_verified_at,
        first_value(snapshot.pr_state) OVER recency AS newest_pr_state,
        first_value(snapshot.is_draft) OVER recency AS newest_is_draft,
        first_value(snapshot.github_created_at) OVER recency
          AS newest_github_created_at,
        first_value(snapshot.closed_at) OVER recency AS newest_closed_at,
        first_value(snapshot.merged_at) OVER recency AS newest_merged_at
      FROM snapshot
      WHERE NOT snapshot.invalid_identity
        AND NOT snapshot.invalid_lifecycle
      WINDOW recency AS (
        PARTITION BY snapshot.repository_full_name, snapshot.number
        ORDER BY snapshot.last_verified_at DESC NULLS LAST, snapshot.id
        ROWS BETWEEN UNBOUNDED PRECEDING AND UNBOUNDED FOLLOWING
      )
    ),
    identity_group AS (
      SELECT
        ranked.repository_full_name,
        ranked.number,
        bool_or(${branchPullRequestUnrankableConflictSql()}) AS conflicting,
        bool_or(ranked.observed) AS observed,
        (array_agg(ranked.id ORDER BY ranked.recency_rank))[1] AS id,
        (array_agg(ranked.repository_id ORDER BY ranked.recency_rank))[1]
          AS repository_id,
        (array_agg(ranked.repository_github_id ORDER BY ranked.recency_rank))[1]
          AS repository_github_id,
        (array_agg(ranked.pr_state ORDER BY ranked.recency_rank))[1] AS pr_state,
        (array_agg(ranked.is_draft ORDER BY ranked.recency_rank))[1] AS is_draft,
        (array_agg(ranked.merged_at ORDER BY ranked.recency_rank))[1]
          AS merged_at,
        (array_agg(ranked.closed_at ORDER BY ranked.recency_rank))[1]
          AS closed_at,
        (array_agg(ranked.additions ORDER BY ranked.recency_rank))[1]
          AS additions,
        (array_agg(ranked.deletions ORDER BY ranked.recency_rank))[1]
          AS deletions,
        (array_agg(ranked.title ORDER BY ranked.recency_rank)
          FILTER (WHERE ranked.title IS NOT NULL))[1] AS title,
        (array_agg(ranked.html_url ORDER BY ranked.recency_rank)
          FILTER (WHERE ranked.html_url IS NOT NULL))[1] AS html_url,
        (array_agg(ranked.review_decision ORDER BY ranked.recency_rank)
          FILTER (WHERE ranked.review_decision IS NOT NULL))[1]
          AS review_decision
      FROM ranked
      GROUP BY ranked.repository_full_name, ranked.number
    ),
    resolved AS (
      SELECT
        identity_group.*,
        (
          identity_group.pr_state = ${GitHubPRState.Open}::"GitHubPRState"
          AND identity_group.observed
        ) AS is_active,
        CASE
          WHEN identity_group.merged_at IS NOT NULL
            THEN identity_group.merged_at
          WHEN identity_group.pr_state = ${GitHubPRState.Closed}::"GitHubPRState"
            THEN identity_group.closed_at
        END AS terminal_at
      FROM identity_group
      WHERE NOT identity_group.conflicting
    ),
    selection_flags AS (
      SELECT
        (
          EXISTS (
            SELECT 1 FROM snapshot
            WHERE snapshot.invalid_identity OR snapshot.invalid_lifecycle
          )
          OR EXISTS (
            SELECT 1 FROM identity_group WHERE identity_group.conflicting
          )
          OR (
            SELECT
              COUNT(*) FILTER (WHERE resolved.is_active) > 1
              OR COUNT(*) FILTER (
                WHERE resolved.pr_state = ${GitHubPRState.Open}::"GitHubPRState"
                  AND NOT resolved.observed
              ) > 1
            FROM resolved
          )
        ) AS blocking,
        (
          SELECT COUNT(*) FILTER (WHERE resolved.is_active) FROM resolved
        ) AS active_count,
        (
          SELECT COUNT(*) FILTER (WHERE resolved.terminal_at IS NOT NULL)
          FROM resolved
        ) AS terminal_count,
        (
          SELECT bool_or(
            ranked.pr_state <> ${GitHubPRState.Open}::"GitHubPRState"
            AND CASE
              WHEN ranked.merged_at IS NOT NULL THEN ranked.merged_at
              WHEN ranked.pr_state = ${GitHubPRState.Closed}::"GitHubPRState"
                THEN ranked.closed_at
            END IS NULL
          )
          FROM ranked
        ) IS TRUE AS missing_terminal
    )
  `;
}

/** `selectCandidate`'s ordered arms, as one filter plus one ordering. */
function branchSelectedPullRequestBodySql(): Prisma.Sql {
  return Prisma.sql`
    SELECT
      resolved.id,
      resolved.number,
      resolved.repository_full_name,
      resolved.pr_state,
      resolved.is_draft,
      resolved.merged_at,
      resolved.closed_at,
      resolved.review_decision,
      resolved.title,
      resolved.html_url,
      resolved.additions,
      resolved.deletions,
      resolved.observed
    FROM resolved
    CROSS JOIN selection_flags
    WHERE NOT selection_flags.blocking
      AND ${branchSelectedPullRequestOwnedSql()}
      AND CASE
        WHEN selection_flags.active_count = 1 THEN resolved.is_active
        WHEN selection_flags.active_count > 0 THEN FALSE
        WHEN selection_flags.missing_terminal THEN FALSE
        WHEN selection_flags.terminal_count > 0
          THEN resolved.terminal_at IS NOT NULL
        ELSE NOT resolved.observed
      END
    ORDER BY
      CASE
        WHEN selection_flags.active_count = 0
          AND selection_flags.terminal_count > 0
          THEN resolved.terminal_at
      END DESC NULLS LAST,
      resolved.repository_full_name COLLATE "C" ASC,
      resolved.number ASC
    LIMIT 1
  `;
}

/**
 * This snapshot disagrees with the newest one it cannot be ordered against.
 * `resolveDuplicateSnapshots` drops the WHOLE identity when that happens, which
 * is why the verdict is folded per group rather than filtered per row.
 */
function branchPullRequestUnrankableConflictSql(): Prisma.Sql {
  return Prisma.sql`(
    ranked.id <> ranked.newest_id
    AND (
      ranked.newest_last_verified_at IS NULL
      OR ranked.last_verified_at IS NULL
      OR ranked.newest_last_verified_at = ranked.last_verified_at
    )
    AND NOT (
      ranked.pr_state IS NOT DISTINCT FROM ranked.newest_pr_state
      AND ranked.is_draft IS NOT DISTINCT FROM ranked.newest_is_draft
      AND ranked.github_created_at
        IS NOT DISTINCT FROM ranked.newest_github_created_at
      AND ranked.closed_at IS NOT DISTINCT FROM ranked.newest_closed_at
      AND ranked.merged_at IS NOT DISTINCT FROM ranked.newest_merged_at
    )
  )`;
}

/**
 * `selectedPullRequestRepositoryFullName`'s four-source precedence, normalized.
 * The branch's own repository RELATION sits third, ahead of the denormalized
 * column — omitting it bound a PR to the wrong identity on a branch whose
 * `repository_full_name` disagrees with its installation repository.
 */
function branchPullRequestRepositoryIdentitySql(): Prisma.Sql {
  return normalizedRepositoryFullNameSql(Prisma.sql`COALESCE(
    prd_repository.full_name,
    prd.repository_full_name,
    branch_repository.full_name,
    b.repository_full_name
  )`);
}

/**
 * `normalizedRepositoryIdentity`: a name that does not parse as exactly two
 * non-empty segments has no identity, and a non-positive number is not a pull
 * request. Either makes the branch's whole selection blocking.
 */
function invalidPullRequestIdentitySql(): Prisma.Sql {
  const identity = branchPullRequestRepositoryIdentitySql();
  return Prisma.sql`(
    prd.number IS NULL
    OR prd.number <= 0
    OR ${identity} IS NULL
    OR array_length(string_to_array(${identity}, '/'), 1) <> 2
    OR split_part(${identity}, '/', 1) = ''
    OR split_part(${identity}, '/', 2) = ''
  )`;
}

/** `normalizedLifecycle`: a draft that is not open, or a draft that merged. */
function invalidPullRequestLifecycleSql(): Prisma.Sql {
  return Prisma.sql`(
    prd.is_draft = TRUE
    AND (
      prd.pr_state <> ${GitHubPRState.Open}::"GitHubPRState"
      OR prd.merged_at IS NOT NULL
    )
  )`;
}

/**
 * The branch owns the selected pull request's repository — the gate
 * `projectCloudOwnedBranchAssociatedPullRequests` applies AFTER selection,
 * nulling the selection without touching the associated collection.
 *
 * The name-fallback arm reads the branch's repository RELATION before the
 * denormalized column, exactly as `branchOwnsSelectedPullRequest` does. Reading
 * only the column disowned a PR whose branch points at a renamed installation
 * repository, so the facet counts would have contradicted the rendered row.
 */
function branchSelectedPullRequestOwnedSql(): Prisma.Sql {
  const branchRepositoryGithubId = branchRepositoryGithubIdSql();
  return Prisma.sql`(
    (
      resolved.repository_github_id IS NOT NULL
      AND ${branchRepositoryGithubId} IS NOT NULL
      AND resolved.repository_github_id = ${branchRepositoryGithubId}
    )
    OR (
      (
        resolved.repository_github_id IS NULL
        OR ${branchRepositoryGithubId} IS NULL
      )
      AND resolved.repository_full_name
        = ${normalizedRepositoryFullNameSql(Prisma.sql`COALESCE(
          (
            SELECT owning_repository.full_name
            FROM github_installation_repositories owning_repository
            WHERE owning_repository.id = b.repository_id
              AND ${repositoryOwnedByArtifactOrganizationSql(Prisma.sql`owning_repository`)}
          ),
          b.repository_full_name
        )`)}
    )
  )`;
}

/**
 * Stable provider identity follows the branch FK across an unclaimed prior
 * installation after reinstall; only equality is consumed and no row data is
 * projected from that historical installation.
 */
function branchRepositoryGithubIdSql(): Prisma.Sql {
  return Prisma.sql`(
    SELECT owning_repository.github_repo_id
    FROM github_installation_repositories owning_repository
    WHERE owning_repository.id = b.repository_id
  )`;
}

/** Stable provider identity for selected PR snapshots retained across reinstall. */
function pullRequestRepositoryGithubIdSql(): Prisma.Sql {
  return Prisma.sql`(
    SELECT selected_repository.github_repo_id
    FROM github_installation_repositories selected_repository
    WHERE selected_repository.id = prd.repository_id
  )`;
}

/**
 * In-database twin of `hasObservedPullRequestEvidence`
 * (`packages/api/src/types/pull-request-lifecycle-observation.ts`): whether this
 * row observed ANYTHING, or holds nothing beyond the server-derived identity
 * the desktop lane writes the moment a PR is opened.
 *
 * `pr_state` and `is_draft` are NOT NULL with defaults, so presence proves
 * nothing — but a TERMINAL state and an `is_draft` of TRUE are values no default
 * can produce, so both count, exactly as they do on the TypeScript side.
 */
function observedPullRequestEvidenceSql(): Prisma.Sql {
  return Prisma.sql`(
    prd.merged_at IS NOT NULL
    OR prd.closed_at IS NOT NULL
    OR prd.pr_state IN (
      ${GitHubPRState.Merged}::"GitHubPRState",
      ${GitHubPRState.Closed}::"GitHubPRState"
    )
    OR prd.is_draft = TRUE
    OR prd.github_created_at IS NOT NULL
    OR prd.title IS NOT NULL
    OR prd.review_decision IS NOT NULL
    OR prd.additions IS NOT NULL
    OR prd.deletions IS NOT NULL
    OR prd.changed_files IS NOT NULL
  )`;
}
