/**
 * The Delivery view's pull-request population queries.
 *
 * Split out of the grandfathered `service.ts` (ISS-5411) so the merged-PR row
 * scan, its exact count, and the closed-PR count that pairs with it live
 * together with the reasoning about what each one is precise about. Mirrors the
 * sibling `lost-work-queries.ts` / `tokenops-waste-queries.ts` split.
 *
 * Two shapes of "how many merged PRs" live here on purpose:
 *
 * - {@link fetchMergedPrs} materializes rows, so it is bounded by
 *   {@link MERGED_PR_SCAN_CAP}.
 * - {@link countMergedPrsInRange} / {@link countDistinctPriorMergedPrs} /
 *   {@link countClosedPrs} are uncapped counts, so the headline figures stay
 *   exact at any org size.
 *
 * A `count()` counts ROWS, and one pull request can be projected by two of
 * them. `merged-pr-loc.ts` owns the identity that reconciles the two: the
 * current window corrects its row count with the scan it already holds
 * (`distinctMergedPrCount`), and the windows this module has no rows for count
 * distinct identities in SQL ({@link countDistinctPrs}).
 */

import { InsightsScope } from "@repo/api/src/types/insights";
import { GitHubPRState, Prisma, withDb } from "@repo/database";
import type { ProjectedPrIdentityInput } from "@/app/insights/merged-pr-loc";
import {
  artifactScope,
  type InsightsScopeContext,
} from "@/app/insights/service";
import { toNumber } from "@/lib/prisma-number";

// FEA-2878: the delivery view's merged-PR summary aggregates (median time-to-
// merge, KLOC totals, and the repo/TTM/lifespan histograms) are computed
// app-side over the materialized merged-PR rows. For the "all" period
// (range.start = epoch) an unbounded fetch would pull every merged PR org-wide.
// The scan is therefore capped to the most recent
// MERGED_PR_SCAN_CAP rows (newest-first). The headline "Merged PRs" count comes
// from an exact DB count() corrected for the duplicate rows the scan can see
// (ISS-5411), and the prior operand its delta compares against is an uncapped
// DB aggregate (ISS-5624), so both stay precise for any org size. Every other
// delivery aggregate that reads these rows — the median-TTM / KLOC /
// median-PR-size KPIs and the repo, TTM, and lifespan histograms — is computed
// over the retained window, so it degrades gracefully (biased toward the most
// recent activity) only once a single period exceeds the cap. A `take`/cursor
// drop-in without the separate count() would instead corrupt the count itself,
// which is why the two are split. The cap is generous enough that realistic
// orgs are unaffected; a supporting (organizationId, prState, mergedAt) index is
// tracked separately (Dexter).
export const MERGED_PR_SCAN_CAP = 25_000;

export type MergedPrRow = ProjectedPrIdentityInput & {
  mergedAt: Date | null;
  branchArtifactId: string;
  repository: { name: string } | null;
  branchArtifact: { createdAt: Date };
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
  return withDb((db) =>
    db.pullRequestDetail.findMany({
      where: mergedPrWhere(ctx, start, end),
      select: {
        mergedAt: true,
        repositoryId: true,
        // FEA-2732: fallback repo identity for repo-less (non-App) merged PRs.
        repositoryFullName: true,
        branchArtifactId: true,
        repository: { select: { name: true } },
        branchArtifact: { select: { createdAt: true } },
        // PLN-1535 M4: PR identity components + the PR's own diff stats.
        id: true,
        number: true,
        githubId: true,
        additions: true,
        deletions: true,
      },
      // FEA-2878: bound the scan so the "all" period cannot materialize every
      // merged PR org-wide. Newest-first so the retained window is the most
      // recent — it covers the 90-day trend charts in full unless a single
      // period's merged count exceeds the cap, and biases the capped
      // distribution toward current activity. The headline "Merged PRs" count
      // comes from countMergedPrsInRange, not this (possibly capped) row set.
      orderBy: { mergedAt: "desc" },
      take: MERGED_PR_SCAN_CAP,
    })
  );
}

/**
 * FEA-2878: exact count of merged PR ROWS in [start, end], matching
 * {@link mergedPrWhere} (and thus {@link fetchMergedPrs}) so the "Merged PRs"
 * KPI, its delta, and prByState stay precise even when the row scan is capped.
 *
 * ISS-5411: rows, not pull requests. The caller already holds the row scan for
 * this window, so it corrects this count itself via `distinctMergedPrCount`
 * rather than paying for a second scan here.
 */
export function countMergedPrsInRange(
  ctx: InsightsScopeContext,
  start: Date,
  end: Date
): Promise<number> {
  return withDb((db) =>
    db.pullRequestDetail.count({ where: mergedPrWhere(ctx, start, end) })
  );
}

/**
 * The prior window's merged-PR count, on the same distinct-pull-request basis
 * as the current window (ISS-5411) — otherwise the period-over-period delta
 * compares a deduped figure against a raw row count and reads as movement that
 * never happened.
 *
 * Half-open [start, end) so the prior window cannot double-count the boundary
 * instant with the current one.
 */
export function countDistinctPriorMergedPrs(
  ctx: InsightsScopeContext,
  start: Date | null,
  end: Date
): Promise<number> {
  if (!start) {
    return Promise.resolve(0);
  }
  return countDistinctPrs(
    ctx,
    Prisma.sql`p.pr_state = ${GitHubPRState.MERGED}::"GitHubPRState"
      AND p.merged_at >= ${start} AND p.merged_at < ${end}`
  );
}

// FEA-3151: closed-WITHOUT-merge PRs → the DECIDED denominator's closed side.
// Paired with countMergedPrsInRange, this forms the DECIDED denominator
// merged + closed the shared MergeRate KPI divides by — so the cloud merge rate
// equals the Desktop/Web value for the same corpus. (`prState CLOSED` is
// closed-without-merge: a merged PR normalizes to prState MERGED, matching the
// NormalizedPr `state`-authoritative disjointness the SSOT decidedPrs relies on.)
//
// ISS-5411: counted on the same distinct-pull-request basis as the merged side,
// which is what preserves the parity FEA-3151 built this KPI for. Desktop rates
// one local `pull_request` artifact per real PR, so its operands are already
// per-PR; cloud's projection rows are not. Raw/raw only matches desktop when the
// duplicate RATE happens to be equal on both sides and cancels — dedupe both and
// the two surfaces divide the same two numbers by construction.
//
// FEA-3208: count CLOSED by `prState` (the desktop pr_state basis) BUT keep the
// period window — window null-safely on the branch artifact's `createdAt`, NOT on
// the nullable `closedAt`. `closedAt` is nullable (schema.prisma
// PullRequestDetail:~1325) and PullRequestDetail carries no created/updated
// timestamp of its own, so the previous `closedAt BETWEEN start AND end` window
// silently DROPPED any genuinely-CLOSED PR whose closedAt was never populated
// (e.g. `gh`/webhook enrichment that set pr_state CLOSED but not the timestamp).
// That shrank the denominator and inflated the cloud merge rate above the true
// value AND above Desktop/Web (e.g. 8/(8+2)=80% vs desktop 8/(8+4)=67%).
//
// The fix must NOT over-correct by dropping the window entirely — that would mix
// an all-time closed denominator with the windowed `mergedAt` numerator
// (countMergedPrsInRange) and skew the rate the other way. Instead we window on
// `branchArtifact.createdAt`, the null-safe cloud analogue of the desktop SSOT's
// `COALESCE(observed_at, created_at) BETWEEN $1 AND $2` window over the whole
// captured PR population (local-insights.ts merge-rate query): Artifact.createdAt
// is `@default(now())`, never null, so a genuinely-decided PR with a null
// closedAt is RETAINED while an all-time-old closed PR observed outside the
// period is EXCLUDED. `artifactScopeSql(ctx)` keeps the count tenant-correct;
// the merged side stays windowed on `mergedAt` (countMergedPrsInRange) and is
// unchanged.
export function countClosedPrs(
  ctx: InsightsScopeContext,
  start: Date,
  end: Date
): Promise<number> {
  return countDistinctPrs(
    ctx,
    Prisma.sql`p.pr_state = ${GitHubPRState.CLOSED}::"GitHubPRState"
      AND a.created_at >= ${start} AND a.created_at <= ${end}`
  );
}

/** Closed-interval [start, end] predicate for merged PRs. Shared by the row
 * scan and its exact count so the two never disagree at the window boundary. */
function mergedPrWhere(
  ctx: InsightsScopeContext,
  start: Date,
  end: Date
): Prisma.PullRequestDetailWhereInput {
  return {
    branchArtifact: artifactScope(ctx),
    prState: GitHubPRState.MERGED,
    mergedAt: { gte: start, lte: end },
  };
}

/**
 * Raw-SQL mirror of {@link projectedPrIdentity}, so a population this endpoint
 * holds no rows for can be counted on the DISTINCT-pull-request basis without
 * shipping one row per projection (ISS-5624).
 *
 * Same precedence, same case-fold: `repo:` → `repoId:` → `gh:` → `row:`. The
 * `NULLIF`s are what keep it exact rather than merely similar — the TypeScript
 * original tests truthiness, so an empty-string `repositoryFullName` or
 * `githubId` falls through to the next component, while a bare `IS NOT NULL`
 * would key on `repo:#7`. **Keep the two in lockstep**: two identity helpers
 * that disagree dedupe the same pull request in one reader and not the other,
 * which is the exact class of bug ISS-5411 fixed.
 */
const PROJECTED_PR_IDENTITY_SQL = Prisma.sql`
  CASE
    WHEN NULLIF(p.repository_full_name, '') IS NOT NULL
      THEN 'repo:' || lower(p.repository_full_name) || '#' || p.number::text
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
 * joins; the org/user/team scope comes from {@link artifactScopeSql}.
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
          WHERE ${artifactScopeSql(ctx)} AND ${predicate}
        ) AS distinct_prs`
    );
    return toNumber(rows[0]?.n);
  });
}

/**
 * Raw-SQL mirror of {@link artifactScope} for the distinct-PR counts, which
 * aggregate in Postgres and so cannot use a Prisma relation filter. Emits a
 * WHERE condition over the `a` (branch `artifacts`) alias the caller joins.
 * Keep the two scope predicates in lockstep — same shape as the
 * `sessionScope`/`sessionScopeSql` pair in `service.ts`.
 */
function artifactScopeSql(ctx: InsightsScopeContext): Prisma.Sql {
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
