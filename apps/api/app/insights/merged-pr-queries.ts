/**
 * The Delivery view's pull-request population queries.
 *
 * Split out of the grandfathered `service.ts` (ISS-5411) so the merged-PR row
 * scan lives together with the reasoning about what it is precise about. Mirrors
 * the sibling `lost-work-queries.ts` / `tokenops-waste-queries.ts` split.
 *
 * {@link fetchMergedPrs} materializes rows, so it is bounded by
 * {@link MERGED_PR_SCAN_CAP}. The headline Merged PRs, its prior window, the
 * closed-unmerged count and the median are not read here: they come from the
 * Branches card's own fold (`delivery-pull-request-facts.ts`, ISS-12408).
 * {@link countDistinctMergedPrsFrom} remains for the profile's PRs-landed figure.
 */

import { InsightsScope } from "@repo/api/src/types/insights";
import { GitHubPRState, Prisma, withDb } from "@repo/database";
import { branchProductWroteExistsSql } from "@/app/branches/branch-contribution-sql";
import type { ProjectedPrIdentityInput } from "@/app/insights/merged-pr-loc";
import type { InsightsScopeContext } from "@/app/insights/service/scope";
import { toNumber } from "@/lib/prisma-number";
import {
  orgMergedPullRequestMembershipSql,
  sessionLinkedPullRequestMembershipSql,
} from "@/lib/pull-request-population";
import type { MergedPrVerificationCensus } from "./delivery-measurement";

// FEA-2878: the delivery view's merged-PR summary aggregates (median time-to-
// merge, KLOC totals, and the repo/TTM/lifespan histograms) are computed
// app-side over the materialized merged-PR rows. For the "all" period
// (range.start = epoch) an unbounded fetch would pull every merged PR org-wide.
// The scan is therefore capped to the most recent MERGED_PR_SCAN_CAP rows
// (newest-first). The headline Merged PRs count, its prior operand, the
// closed-unmerged count and the median PR size are not computed from these
// rows: they come from the shared SQL fold, uncapped (ISS-12408). Every other
// aggregate that reads these rows (median-TTM, KLOC, and the repo, TTM and
// lifespan histograms) is computed over the retained window, so it degrades
// gracefully (biased toward the most recent activity) only once a single period
// exceeds the cap. The cap is generous enough that realistic orgs are
// unaffected; a supporting (organizationId, prState, mergedAt) index is tracked
// separately (Dexter).
export const MERGED_PR_SCAN_CAP = 25_000;

export type MergedPrRow = ProjectedPrIdentityInput & {
  mergedAt: Date | null;
  prState: string | null;
  lastVerifiedAt: Date | null;
  branchArtifactId: string;
  repository: { name: string; fullName: string } | null;
  branchArtifact: {
    id: string;
    createdAt: Date;
    _count: { pullRequestDetails: number };
  };
  // PLN-1535 M4: the PR's OWN diff size, so KLOC and Median PR size read
  // per-PR projection LOC instead of the branch file cache. See
  // `merged-pr-loc.ts` for why the branch-keyed derivation was wrong.
  additions: number | null;
  deletions: number | null;
};

export function fetchMergedPrs(
  ctx: InsightsScopeContext,
  start: Date,
  end: Date
): Promise<MergedPrRow[]> {
  return withDb(async (db) => {
    const scanned = await db.$queryRaw<{ id: string }[]>(
      Prisma.sql`
        SELECT p.id
        FROM pull_request_detail p
        JOIN artifacts a ON a.id = p.branch_artifact_id
        WHERE ${pullRequestScopeSql(ctx)}
          AND p.pr_state = ${GitHubPRState.MERGED}::"GitHubPRState"
          AND p.merged_at >= ${start} AND p.merged_at <= ${end}
          AND ${orgMergedPullRequestMembershipSql(ctx.organizationId)}
        ORDER BY p.merged_at DESC, p.id ASC
        LIMIT ${MERGED_PR_SCAN_CAP}`
    );
    const scannedIds = scanned.map((row) => row.id);
    if (scannedIds.length === 0) {
      return [];
    }
    const scanIndexById = new Map(
      scannedIds.map((id, index) => [id, index] as const)
    );
    const details = await db.pullRequestDetail.findMany({
      where: { id: { in: scannedIds } },
      select: {
        mergedAt: true,
        prState: true,
        lastVerifiedAt: true,
        repositoryId: true,
        // FEA-2732: fallback repo identity for repo-less (non-App) merged PRs.
        repositoryFullName: true,
        branchArtifactId: true,
        repository: { select: { name: true, fullName: true } },
        branchArtifact: {
          select: {
            id: true,
            createdAt: true,
            _count: { select: { pullRequestDetails: true } },
          },
        },
        // PLN-1535 M4: PR identity components + the PR's own diff stats.
        id: true,
        number: true,
        githubId: true,
        additions: true,
        deletions: true,
      },
    });
    return [...details].sort(
      (left, right) =>
        (scanIndexById.get(left.id) ?? Number.MAX_SAFE_INTEGER) -
        (scanIndexById.get(right.id) ?? Number.MAX_SAFE_INTEGER)
    );
  });
}

/**
 * Raw-SQL mirror of {@link projectedPrIdentity}, so a population this endpoint
 * holds no rows for can be counted on the DISTINCT-pull-request basis without
 * shipping one row per projection (ISS-5624).
 *
 * Same precedence, same case-fold: installed repo full name or row full name
 * → `repoId:` → `gh:` → `row:`. The `NULLIF`s are what keep it exact rather
 * than merely similar — the TypeScript original tests truthiness, so an
 * empty-string repo name or `githubId` falls through to the next component,
 * while a bare `IS NOT NULL` would key on `repo:#7`. **Keep the two in
 * lockstep**: two identity helpers that disagree dedupe the same pull request
 * in one reader and not the other, which is the exact class of bug ISS-5411
 * fixed.
 */
export const PROJECTED_PR_IDENTITY_SQL = Prisma.sql`
  CASE
    WHEN COALESCE(
      NULLIF(pr_repository.full_name, ''),
      NULLIF(p.repository_full_name, '')
    ) IS NOT NULL
      THEN 'repo:' || lower(COALESCE(
        NULLIF(pr_repository.full_name, ''),
        NULLIF(p.repository_full_name, '')
      )) || '#' || p.number::text
    WHEN p.repository_id IS NOT NULL
      THEN 'repoId:' || p.repository_id::text || '#' || p.number::text
    WHEN NULLIF(p.github_id, '') IS NOT NULL
      THEN 'gh:' || p.github_id
    ELSE 'row:' || p.id::text
  END`;

/**
 * A PR count on the DISTINCT-pull-request basis, for a population this endpoint
 * does not already hold rows for (ISS-5411), counted in the DB (ISS-5624).
 *
 * `predicate` is the PR-side half of the WHERE, over the `p`
 * (`pull_request_detail`) and `a` (branch `artifacts`) aliases this statement
 * joins; the org/user/team scope comes from {@link pullRequestScopeSql}, and the
 * ISS-8153 org-merged membership (`orgMergedPullRequestMembershipSql`) is
 * ANDed in unconditionally — every caller counts the session-linked+verified
 * population on purpose, per the D1/D6 rulings.
 *
 * This used to pair an exact `count()` with a {@link MERGED_PR_SCAN_CAP}-capped
 * identity scan and subtract the duplicates the scan could see. That shipped up
 * to 25,000 rows per call and sorted them on a column combination no
 * `PullRequestDetail` index covers, twice per Delivery request, purely to
 * produce one integer — and on the "all" period the predicate matches the org's
 * entire merged/closed history, so the sort ran over the whole population
 * before `take` could discard anything. Counting the distinct identities in
 * Postgres ships one row, drops the ordering requirement, and makes the figure
 * EXACT: the correction is no longer bounded by what a capped slice happened to
 * co-locate, so these counts no longer under-report above the cap.
 *
 * `SELECT COUNT(*) FROM (SELECT DISTINCT …)` rather than `COUNT(DISTINCT …)`
 * because Postgres has no hash implementation of `COUNT(DISTINCT)` — it always
 * sorts — while the derived table lets the planner pick a HashAggregate.
 *
 * Cost, stated plainly: one pooled query per call (it was two). `withDb` holds
 * no connection of its own; each query inside it borrows from the pool
 * independently (see `apps/api` AGENTS.md). It is still issued unconditionally
 * even when the caller ends up suppressing the figure (the "full prior period"
 * rule resolves from `earliestRecord` in the same concurrent wave, so there is
 * nothing to gate on without serializing the wave).
 */
function countDistinctPrs(
  ctx: InsightsScopeContext,
  predicate: Prisma.Sql
): Promise<number> {
  return withDb(async (db) => {
    const rows = await db.$queryRaw<{ n: number }[]>(
      Prisma.sql`
        SELECT COUNT(*)::int AS n
        FROM (
          SELECT DISTINCT ${PROJECTED_PR_IDENTITY_SQL} AS identity
          FROM pull_request_detail p
          JOIN artifacts a ON a.id = p.branch_artifact_id
          LEFT JOIN github_installation_repositories pr_repository
            ON pr_repository.id = p.repository_id
          WHERE ${pullRequestScopeSql(ctx)} AND ${predicate}
            AND ${orgMergedPullRequestMembershipSql(ctx.organizationId)}
        ) AS distinct_prs`
    );
    return toNumber(rows[0]?.n);
  });
}

/**
 * The scope every `pull_request_detail` read in this module applies: the branch
 * artifact's org (via {@link artifactScopeSql}, unchanged) AND the PR row's own
 * denormalized `organization_id`.
 *
 * ISS-6825. The second conjunct is redundant in MEANING and decisive for the
 * PLAN. `PullRequestDetail.organizationId` is a write-once copy of the parent
 * branch Artifact's org (FEA-2732 / PRD-510 D2), so a row can only satisfy the
 * joined predicate if it satisfies this one — the admitted set is identical, and
 * `pull-request-population-realdb` / `delivery-cross-surface-invariant` pin that
 * across org, team and me.
 *
 * What changes is reachability. Scoping the org ONLY through the joined artifact
 * left `pull_request_detail_organization_id_pr_state_merged_at_idx` with its
 * LEADING column unconstrained, so the planner could not seek on it: measured on
 * a 24,000-row fixture whose tenant holds a twelfth of the table, the scan came
 * back `Index Cond: ((pr_state = 'MERGED') AND (merged_at >= ...) AND
 * (merged_at <= ...))` — no `organization_id` — walking the whole index, keeping
 * 44 rows and discarding 484 by Filter, and running the membership SubPlan once
 * per row it emitted. Naming the PR's own org column puts it in the Index Cond
 * and bounds the scan to the tenant before that filter is ever reached.
 *
 * The joined predicate is KEPT rather than replaced: it is what carries the
 * team/me arms, which have no denormalized counterpart on the PR row.
 *
 * ISS-11589 (operator ruling, Cosimo Corrigan, 2026-10-09): only a Branch a
 * session WROTE to counts, the same Wrote evidence the Branches list admits on.
 * A session that merely linked or reviewed the PR does not put it in this
 * population. Every count here shares this scope so the merged side, the prior
 * window and the closed denominator keep reading one universe.
 *
 * The scalar wrapper keeps the check a per-row subplan. A bare EXISTS is pulled
 * up into the join, and the planner then starts from the org's session links and
 * walks to the PRs instead of seeking the merged window on the tenant index
 * (`iss6825-delivery-org-scope-plan`).
 */
function pullRequestScopeSql(ctx: InsightsScopeContext): Prisma.Sql {
  return Prisma.sql`${artifactScopeSql(ctx)}
    AND p.organization_id = ${ctx.organizationId}::uuid
    AND COALESCE((SELECT TRUE WHERE ${branchProductWroteExistsSql()}), FALSE)`;
}

/**
 * Raw-SQL mirror of {@link artifactScope} for the distinct-PR counts, which
 * aggregate in Postgres and so cannot use a Prisma relation filter. Emits a
 * WHERE condition over the `a` (branch `artifacts`) alias the caller joins.
 * Keep the two scope predicates in lockstep — same shape as the
 * `sessionScope`/`sessionScopeSql` pair in `service.ts`.
 */
export function artifactScopeSql(ctx: InsightsScopeContext): Prisma.Sql {
  const org = Prisma.sql`a.organization_id = ${ctx.organizationId}::uuid`;
  if (ctx.scope === InsightsScope.Me) {
    return Prisma.sql`${org} AND a.created_by_id = ${ctx.userId}::uuid`;
  }
  if (ctx.scope === InsightsScope.Team && !ctx.teamId) {
    return Prisma.sql`false`;
  }
  if (ctx.scope === InsightsScope.Team && ctx.teamId) {
    return Prisma.sql`${org} AND EXISTS (
      SELECT 1 FROM team_members tm
      WHERE tm.user_id = a.created_by_id AND tm.team_id = ${ctx.teamId}::uuid
    )`;
  }
  return org;
}

/**
 * The profile "PRs landed" figure (cr on PR #6112): DISTINCT merged pull
 * requests from `start` (or all time), on the same projected-identity basis
 * and org-merged membership as the Delivery KPI — so the profile and Insights
 * read one number for one universe. A branch-based count under-reports a
 * multi-PR branch and a row-based count over-reports a twin projection; this
 * is the basis that matches the label.
 */
export function countDistinctMergedPrsFrom(
  ctx: InsightsScopeContext,
  start: Date | null
): Promise<number> {
  const window = start
    ? Prisma.sql`p.merged_at >= ${start}`
    : Prisma.sql`p.merged_at IS NOT NULL`;
  return countDistinctPrs(
    ctx,
    Prisma.sql`p.pr_state = ${GitHubPRState.MERGED}::"GitHubPRState"
      AND ${window}`
  );
}

/**
 * ISS-8424: whether this scope has session-linked merged pull requests, and
 * whether verification has reached any of them.
 *
 * The Delivery read renders a `0` for an empty {@link orgMergedPullRequestWhere}
 * population, and that number is only honest when the population is empty
 * because nothing qualifies. On an OAuth-only org there is no webhook lane, so
 * `lastVerifiedAt` is written solely by the tier-2 targeted sync; until it has
 * run, EVERY session-linked merged row fails the verification clause and the
 * whole delivery surface reads as a measured zero. These two facts are what
 * tells the two states apart — linked-but-nothing-verified is a population
 * nobody has measured yet, not one that measured zero.
 *
 * Two `EXISTS` probes rather than the two aggregate counts this started as
 * (cr, database-architect). The only consumer is a `>0` / `=== 0` decision, and
 * this statement runs on EVERY Delivery request: a count must visit every
 * qualifying row before it can answer, while a probe stops at the first — so
 * the steady-state case (an org whose verification landed long ago) no longer
 * pays a full scan of its merged history on each page load. The return type is
 * boolean for the same reason it is cheaper: a count nobody consumes is a
 * number a later reader could mistake for a measurement.
 *
 * Windowed on the SAME `[start, end]` the merged reads take (cr, review-soul).
 * An all-time census decides a windowed render: one verified row anywhere in
 * the org's history would make a window whose session-linked merges are ALL
 * unverified print a confident `0` — the same fabricated measurement, one
 * window narrower, and the normal steady state for an OAuth-only org between
 * sync ticks. Nothing is lost by windowing: an org with a verified history and
 * a quiet fortnight has no session-linked merged rows IN that window, so
 * `hasSessionLinkedMergedPrs` is false and it renders its honest 0 anyway.
 *
 * The verified probe composes {@link orgMergedPullRequestMembershipSql} — the
 * canonical population predicate — and the linked probe its extracted
 * session-link half, so neither can drift from the population the tiles count.
 */
type MergedPrVerificationCensusRow = {
  hasSessionLinkedMergedPrs: boolean;
  hasVerifiedMergedPrs: boolean;
};

export function censusMergedPrVerification(
  ctx: InsightsScopeContext,
  start: Date,
  end: Date
): Promise<MergedPrVerificationCensus> {
  const probe = (membership: Prisma.Sql) =>
    mergedPrExistsProbeSql(ctx, membership, start, end);
  return withDb(async (db) => {
    const rows = await db.$queryRaw<MergedPrVerificationCensusRow[]>(
      Prisma.sql`
        SELECT
          ${probe(
            sessionLinkedPullRequestMembershipSql(ctx.organizationId)
          )} AS "hasSessionLinkedMergedPrs",
          ${probe(
            orgMergedPullRequestMembershipSql(ctx.organizationId)
          )} AS "hasVerifiedMergedPrs"`
    );
    return {
      hasSessionLinkedMergedPrs: rows[0]?.hasSessionLinkedMergedPrs === true,
      hasVerifiedMergedPrs: rows[0]?.hasVerifiedMergedPrs === true,
    };
  });
}

/**
 * One scoped merged-PR existence probe, parameterized by the membership
 * predicate it applies. Both probes share every clause but that one, so a
 * second spelling of the scope or the merged filter is the drift this shape
 * removes.
 */
function mergedPrExistsProbeSql(
  ctx: InsightsScopeContext,
  membership: Prisma.Sql,
  start: Date,
  end: Date
): Prisma.Sql {
  return Prisma.sql`EXISTS (
    SELECT 1
    FROM pull_request_detail p
    JOIN artifacts a ON a.id = p.branch_artifact_id
    WHERE ${pullRequestScopeSql(ctx)}
      AND p.pr_state = ${GitHubPRState.MERGED}::"GitHubPRState"
      AND p.merged_at >= ${start} AND p.merged_at <= ${end}
      AND ${membership}
  )`;
}
