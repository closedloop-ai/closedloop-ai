import { BranchStatus } from "@repo/api/src/types/branch";
import { BranchIdentityAvailability } from "@repo/api/src/types/branch-identity";
import {
  BranchListLastActiveRange,
  BranchListPullRequestPresence,
  BranchListSortKey,
  type BranchServerPageQuery,
} from "@repo/api/src/types/branch-list-contract";
import { GitHubPRState } from "@repo/api/src/types/github";
import { Prisma } from "@repo/database";
import {
  BRANCH_OWNER_UNATTRIBUTED_LABEL,
  BRANCH_REPOSITORY_UNKNOWN_LABEL,
} from "@repo/lib/branches/branch-list-page";
import { branchSelectedPullRequestLateralSql } from "../branch-associated-pull-request-sql";
import {
  branchCandidateActivityExpr,
  branchCandidateActivityJoinsSql,
  branchCandidateActivityPredicateSql,
  branchCandidateSortActivityExpr,
  branchCandidateStaticWhereClause,
  normalizedRepositorySortKey,
} from "../branch-candidate-read";
import { branchLinkedSessionCountSql } from "../branch-contribution-sql";
import type { BranchListOperationQuery } from "../branch-list-query";
import {
  closedloopPersonKeySql,
  displayUserNameSql,
} from "../branch-read-service/branch-session-identity-sql";
import { repositoryOwnedByArtifactOrganizationSql } from "../branch-repository-name-sql";
import { branchListDateWindowSql } from "./branch-list-filter-sql";
import {
  branchCollaboratorIdentityCtesSql,
  branchCollaboratorIdentityJoinSql,
} from "./branch-list-identity-sql";

/**
 * The per-branch scalars the Branch list kernel filters, sorts and facets on,
 * derived in the database instead of off a fully projected `BranchRow`.
 *
 * ISS-10298: `pageMode=server` used to hydrate and project the WHOLE eligible
 * corpus before keeping 25 rows, because the eight facet counts describe the
 * corpus and the JavaScript fold could only read them off projected rows.
 * Everything those facets and sorts actually need is here, so the projection is
 * now page-bounded and the counts still describe the corpus.
 *
 * Each column is the in-database twin of one derivation in
 * `projectCanonicalCloudBranchRow` / `packages/lib/branches/branch-list-page.ts`,
 * and `branch-list-sql-parity.integration.test.ts` holds the two to the same
 * answers over a seeded corpus.
 */
export function branchListDimensionCteSql(
  organizationId: string,
  query: BranchListOperationQuery,
  evaluationNow: Date,
  identityResolved = true,
  pageQuery?: BranchServerPageQuery
): Prisma.Sql {
  const readsLoc = branchListPageReadsLoc(pageQuery);
  return Prisma.sql`
    WITH ${branchListCorpusCtesSql(organizationId, query, evaluationNow, pageQuery)}
    ${identityResolved ? Prisma.sql`, ${branchCollaboratorIdentityCtesSql(Prisma.sql`SELECT corpus.id FROM branch_list_corpus corpus`)}` : Prisma.empty}
    SELECT
      a.id,
      row_number() OVER (
        ORDER BY ${branchCandidateSortActivityExpr(evaluationNow)} DESC NULLS LAST,
          ${normalizedRepositorySortKey()} ASC,
          btrim(b.branch_name) ASC,
          a.id ASC
      ) AS row_ord,
      b.branch_name,
      ${branchListRepositorySql()} AS repository,
      ${branchListStatusSql()} AS status,
      a.priority AS priority,
      selected_pull_request.number AS pull_request_number,
      ${branchListPullRequestPresenceSql()} AS pull_request_presence,
      ${branchListLastActiveAtSql(evaluationNow)} AS last_active_at,
      ${branchListLastActiveRangeSql(evaluationNow)} AS last_active_range,
      ${readsLoc ? branchListLocChangeSql() : Prisma.sql`NULL::int`} AS loc_change,
      ${branchListPageReadsSessions(pageQuery) ? branchLinkedSessionCountSql() : Prisma.sql`NULL::int`} AS session_count,
      COALESCE(branch_tags.tag_ids, ARRAY[]::text[]) AS tag_ids,
      COALESCE(branch_tags.tag_names, ARRAY[]::text[]) AS tag_names,
      ${branchListOwnerColumnsSql()},
      ${branchListCollaboratorColumnsSql(identityResolved)}
    FROM branch_list_corpus corpus
    INNER JOIN artifacts a ON a.id = corpus.id
    INNER JOIN branch_detail b ON b.artifact_id = a.id
    -- The corpus's activity under the alias names the shared activity
    -- expressions read, so they are not re-derived per branch.
    CROSS JOIN LATERAL (
      SELECT corpus.atom_occurred_at AS occurred_at
    ) latest_activity_atom
    CROSS JOIN LATERAL (
      SELECT corpus.linked_session_last_activity_at AS last_activity_at
    ) linked_session_activity
    LEFT JOIN LATERAL (${branchSelectedPullRequestLateralSql()})
      selected_pull_request ON TRUE
    LEFT JOIN github_installation_repositories branch_list_repository
      ON branch_list_repository.id = b.repository_id
      AND ${repositoryOwnedByArtifactOrganizationSql(Prisma.sql`branch_list_repository`)}
    ${readsLoc ? branchListFileChangeTotalsLateralSql() : Prisma.empty}
    ${branchListTagsLateralSql()}
    ${branchListOwnerJoinSql()}
    ${identityResolved ? branchCollaboratorIdentityJoinSql() : Prisma.empty}
  `;
}

/**
 * The Owner dimensions: the branch's own assignee (ISS-12463), keyed and labelled
 * the way `assigneeOwnerIdentity` names the same user in JavaScript. A NULL
 * assignee, or one outside the branch's organization, is the existing
 * Unattributed key and label. A column read is always complete, so Owner sits
 * outside the identity failure domain below.
 */
export function branchListOwnerColumnsSql(): Prisma.Sql {
  return Prisma.sql`
      COALESCE(
        ${closedloopPersonKeySql(Prisma.sql`branch_owner_user.id`)},
        ${BRANCH_OWNER_UNATTRIBUTED_LABEL}
      ) AS owner_key,
      COALESCE(
        ${displayUserNameSql(Prisma.sql`branch_owner_user`)},
        ${BRANCH_OWNER_UNATTRIBUTED_LABEL}
      ) AS owner_label,
      ${BranchIdentityAvailability.Complete}::text AS owner_availability`;
}

/** The assignee row behind {@link branchListOwnerColumnsSql}, scoped to the branch's tenant. */
export function branchListOwnerJoinSql(): Prisma.Sql {
  return Prisma.sql`
    LEFT JOIN users branch_owner_user
      ON branch_owner_user.id = a.assignee_id
      AND branch_owner_user.organization_id = a.organization_id
  `;
}

/**
 * The three collaborator dimensions, or the UNAVAILABLE stanza that stands in
 * for them when the identity enrichment is skipped (ISS-10297's failure domain;
 * davetho review on #7545). The collaborator identity CTEs, and the
 * observed-push owner they read, serve an OPTIONAL facet, so a timeout in them
 * used to reject the whole page read and 500 `/branches`.
 *
 * The stanza is `collaboratorsFor`'s own no-identity arm
 * (`packages/lib/branches/branch-list-page.ts`), value for value: the kernel
 * reaches it whenever `resolveBranchListIdentityData` returned nothing, and the
 * SQL page must land on the same answer or the facets would disagree with the
 * rows the retry pass hydrates beside them.
 *
 * An empty collaborator array is NOT a claim that nobody worked on the branch —
 * `collaborator_availability` carries `unavailable`, which
 * `branchListFacetAvailabilityFromCounts` folds to an `unavailable` FACET once
 * every row reports it. That keeps "we could not read identity"
 * distinguishable from "there is nobody".
 */
function branchListCollaboratorColumnsSql(
  identityResolved: boolean
): Prisma.Sql {
  if (!identityResolved) {
    return Prisma.sql`
      ARRAY[]::text[] AS collaborator_keys,
      ARRAY[]::text[] AS collaborator_labels,
      ${BranchIdentityAvailability.Unavailable}::text
        AS collaborator_availability`;
  }
  return Prisma.sql`
      COALESCE(
        branch_collaborator_identity.collaborator_keys, ARRAY[]::text[]
      ) AS collaborator_keys,
      COALESCE(
        branch_collaborator_identity.collaborator_labels, ARRAY[]::text[]
      ) AS collaborator_labels,
      branch_collaborator_identity.collaborator_availability`;
}

/**
 * `repositoryFor`: the BRANCH's repository, deliberately UN-normalized — the
 * candidate sort key normalizes the same column and this one must not, or a
 * repository stored as `Acme/Repo` would facet under a name its rows do not
 * show. The em dash is the kernel's own fallback and becomes a real facet id.
 */
function branchListRepositorySql(): Prisma.Sql {
  return Prisma.sql`COALESCE(
    branch_list_repository.full_name,
    b.repository_full_name,
    ${BRANCH_REPOSITORY_UNKNOWN_LABEL}
  )`;
}

/**
 * `statusForSelectedCloudPullRequest` folded into its four reachable outcomes.
 * `BranchStatus` carries six members and no producer derives `review` or
 * `blocked` (`packages/api/src/types/branch-status-derivation.ts`), so the
 * facet lists them with a zero count and nothing here emits them.
 *
 * Arm order is load-bearing and is `toBranchStatus`'s: merge evidence beats a
 * stale draft flag, draft precedes closed, and everything left — including a
 * branch with no pull-request evidence at all — is open.
 */
function branchListStatusSql(): Prisma.Sql {
  const observed = Prisma.sql`COALESCE(selected_pull_request.observed, FALSE)`;
  return Prisma.sql`CASE
    WHEN ${observed}
      AND selected_pull_request.pr_state
        = ${GitHubPRState.Merged}::"GitHubPRState"
      THEN ${BranchStatus.Merged}
    WHEN NOT ${observed} AND a.status = ${GitHubPRState.Merged}
      THEN ${BranchStatus.Merged}
    WHEN ${observed} AND COALESCE(selected_pull_request.is_draft, FALSE)
      THEN ${BranchStatus.Draft}
    WHEN a.status = ${GitHubPRState.Closed}
      OR (
        ${observed}
        AND selected_pull_request.pr_state
          = ${GitHubPRState.Closed}::"GitHubPRState"
      )
      THEN ${BranchStatus.Closed}
    ELSE ${BranchStatus.Open}
  END`;
}

/**
 * The candidate-selected Last-active instant (atom, else the ISS-11915
 * linked-session fallback), which is the only source of
 * `canonicalLastActiveAt` on this path. The kernel's `validTimestamp` drops an
 * instant in the FUTURE, so a value past the evaluation clock reads here as
 * absent rather than as activity.
 */
function branchListLastActiveAtSql(evaluationNow: Date): Prisma.Sql {
  return Prisma.sql`CASE
    WHEN ${branchCandidateActivityExpr()} <= ${evaluationNow}
      THEN ${branchCandidateActivityExpr()}
  END`;
}

/** `lastActiveRange`, bucketed against the same pinned evaluation instant. */
function branchListLastActiveRangeSql(evaluationNow: Date): Prisma.Sql {
  const occurredAt = branchListLastActiveAtSql(evaluationNow);
  const age = Prisma.sql`EXTRACT(EPOCH FROM (${evaluationNow} - ${occurredAt})) * 1000`;
  return Prisma.sql`CASE
    WHEN ${occurredAt} IS NULL THEN NULL
    WHEN ${age} < 0 THEN NULL
    WHEN ${age} < ${60 * 60 * 1000}
      THEN ${BranchListLastActiveRange.WithinLastHour}
    WHEN ${age} < ${7 * 60 * 60 * 1000}
      THEN ${BranchListLastActiveRange.OneToSixHours}
    WHEN ${age} < ${24 * 60 * 60 * 1000}
      THEN ${BranchListLastActiveRange.SevenToTwentyFourHours}
    ELSE ${BranchListLastActiveRange.OneDayOrMore}
  END`;
}

/**
 * `rowLocChange` over `resolveDetailLoc(currentFileTotals(...), selectedPr)`.
 *
 * The file-cache fold wins whenever BOTH of its counts survived; the selected
 * pull request's own counts only BACKFILL, never override. A half-populated
 * pair is reachable — `sumWhenComplete` runs per column — and the kernel's
 * `rowLocChange` nulls only when both sides are null, so `(5, null)` is a LOC
 * of 5 rather than unknown.
 */
function branchListLocChangeSql(): Prisma.Sql {
  const cacheAdditions = Prisma.sql`CASE
    WHEN ${branchListFileCacheCurrentSql()} THEN branch_file_totals.additions
  END`;
  const cacheDeletions = Prisma.sql`CASE
    WHEN ${branchListFileCacheCurrentSql()} THEN branch_file_totals.deletions
  END`;
  const additions = Prisma.sql`CASE
    WHEN ${cacheAdditions} IS NOT NULL AND ${cacheDeletions} IS NOT NULL
      THEN ${cacheAdditions}
    WHEN selected_pull_request.additions IS NOT NULL
      AND selected_pull_request.deletions IS NOT NULL
      THEN selected_pull_request.additions
    ELSE ${cacheAdditions}
  END`;
  const deletions = Prisma.sql`CASE
    WHEN ${cacheAdditions} IS NOT NULL AND ${cacheDeletions} IS NOT NULL
      THEN ${cacheDeletions}
    WHEN selected_pull_request.additions IS NOT NULL
      AND selected_pull_request.deletions IS NOT NULL
      THEN selected_pull_request.deletions
    ELSE ${cacheDeletions}
  END`;
  return Prisma.sql`CASE
    WHEN ${additions} IS NULL AND ${deletions} IS NULL THEN NULL
    ELSE COALESCE(${additions}, 0) + COALESCE(${deletions}, 0)
  END`;
}

/**
 * `currentFileTotals`' four all-null exits: a stale or never-synced cache, rows
 * that do not describe the head the row claims the cache is current for (which
 * includes a mid-refresh branch whose rows span two heads), a capped cache, and
 * an empty one.
 */
function branchListFileCacheCurrentSql(): Prisma.Sql {
  return Prisma.sql`(
    b.head_sha IS NOT NULL
    AND b.file_cache_head_sha IS NOT NULL
    AND b.file_cache_head_sha = b.head_sha
    AND branch_file_totals.head_sha IS NOT DISTINCT FROM b.file_cache_head_sha
    AND NOT COALESCE(b.file_cache_capped, FALSE)
    AND branch_file_totals.file_count > 0
  )`;
}

/**
 * `getBranchFileChangeTotals`' grouped fold. `SUM` skips NULLs, so comparing
 * the non-null count against the row count is what reproduces the
 * all-or-nothing rule: any un-enriched file makes that column unavailable
 * rather than confidently short. A branch whose rows span more than one head is
 * mid-refresh, so `head_sha` reads NULL and the gate above rejects it.
 */
function branchListFileChangeTotalsLateralSql(): Prisma.Sql {
  return Prisma.sql`
    LEFT JOIN LATERAL (
      SELECT
        CASE
          WHEN COUNT(DISTINCT fc.head_sha) = 1 THEN MIN(fc.head_sha)
        END AS head_sha,
        COUNT(*)::int AS file_count,
        CASE
          WHEN COUNT(*) = COUNT(fc.additions)
            THEN COALESCE(SUM(fc.additions), 0)::int
        END AS additions,
        CASE
          WHEN COUNT(*) = COUNT(fc.deletions)
            THEN COALESCE(SUM(fc.deletions), 0)::int
        END AS deletions
      FROM branch_file_changes fc
      WHERE fc.branch_artifact_id = a.id
    ) branch_file_totals ON TRUE
  `;
}

/**
 * `projectArtifactTags`: org-scoped at the join, de-duplicated by tag id, in
 * tag-id order. `tagAvailability` is not selected because the cloud list always
 * loads this relation, so it is the constant `available` — the facet's
 * availability fold is applied to that constant in the reader.
 */
function branchListTagsLateralSql(): Prisma.Sql {
  return Prisma.sql`
    LEFT JOIN LATERAL (
      SELECT
        array_agg(scoped_tag.id::text ORDER BY scoped_tag.id) AS tag_ids,
        array_agg(scoped_tag.name ORDER BY scoped_tag.id) AS tag_names
      FROM (
        SELECT DISTINCT ON (t.id) t.id, t.name
        FROM tag_artifacts ta
        INNER JOIN tags t ON t.id = ta.tag_id
        WHERE ta.artifact_id = a.id
          AND t.organization_id = a.organization_id
        ORDER BY t.id
      ) scoped_tag
    ) branch_tags ON TRUE
  `;
}

/** `hasPullRequest`: an associated pull request, or a selected number. */
function branchListPullRequestPresenceSql(): Prisma.Sql {
  return Prisma.sql`CASE
    WHEN (
      selected_pull_request.associated_count > 0
      OR selected_pull_request.number IS NOT NULL
    ) THEN ${BranchListPullRequestPresence.Linked}
    ELSE ${BranchListPullRequestPresence.None}
  END`;
}

/**
 * ISS-12775: only the Changes sort and the LOC range read `loc_change`, and only
 * the Sessions sort reads `session_count`; no facet counts either. Prod spent
 * 1,038ms of a cold 15.9s default page summing `branch_file_changes` for 6,738
 * branches nothing read. Without a page query every column is computed.
 */
function branchListPageReadsLoc(pageQuery?: BranchServerPageQuery): boolean {
  return (
    !pageQuery ||
    pageQuery.sortKey === BranchListSortKey.Changes ||
    pageQuery.locMin !== undefined ||
    pageQuery.locMax !== undefined
  );
}

function branchListPageReadsSessions(
  pageQuery?: BranchServerPageQuery
): boolean {
  return !pageQuery || pageQuery.sortKey === BranchListSortKey.Sessions;
}

/**
 * ISS-12775: the eligible, date-windowed corpus, resolved before any other
 * per-branch read. Both CTEs are fences: without them prod read the latest atom
 * for 8,568 candidates and the pull request, tags and owner laterals for 6,738,
 * then dropped them to the 3,751 the page counts. Eligibility needs no activity,
 * so it runs first; the activity laterals then read only eligible branches.
 * Facets still see every date-eligible branch, including unknown activity.
 */
function branchListCorpusCtesSql(
  organizationId: string,
  query: BranchListOperationQuery,
  evaluationNow: Date,
  pageQuery?: BranchServerPageQuery
): Prisma.Sql {
  return Prisma.sql`
    branch_list_eligible AS MATERIALIZED (
      SELECT a.id
      FROM artifacts a
      INNER JOIN branch_detail b ON b.artifact_id = a.id
      ${branchCandidateStaticWhereClause(organizationId, query)}
    ),
    branch_list_corpus AS MATERIALIZED (
      SELECT
        a.id,
        latest_activity_atom.occurred_at AS atom_occurred_at,
        linked_session_activity.last_activity_at
          AS linked_session_last_activity_at
      FROM branch_list_eligible eligible
      INNER JOIN artifacts a ON a.id = eligible.id
      ${branchCandidateActivityJoinsSql()}
      WHERE ${branchCandidateActivityPredicateSql(query, evaluationNow)}
      ${pageQuery ? Prisma.sql`AND ${branchListDateWindowSql(pageQuery, branchListLastActiveAtSql(evaluationNow))}` : Prisma.empty}
    )
  `;
}
