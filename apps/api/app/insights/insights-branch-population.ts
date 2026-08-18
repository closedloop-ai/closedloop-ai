import type { CategoryBucket, DonutSlice } from "@repo/api/src/types/insights";
import { ChecksStatus, type Prisma, withDb } from "@repo/database";

/**
 * The two branch-population donut charts ("Check status", "Branch coverage")
 * for the Delivery insights section (ISS-4634). Extracted from `service.ts` so
 * the branch-population concern owns its own module rather than growing the
 * grandfathered composition root.
 *
 * Both charts window the branch POPULATION on the selected range but group by a
 * CURRENT-STATE attribute (checks status now, PR link now) — there is no per-day
 * history of either attribute, so windowing the attribute is not expressible and
 * would not be meaningful. The section reads "of the branches active in the last
 * N days, here is where they stand now".
 */

/**
 * ISS-4634: the period predicate for the two branch-population charts.
 *
 * Both charts previously aggregated the ENTIRE org branch population regardless
 * of the selected range, so they sat under the "Last N days" caption reading as
 * windowed while never re-scoping — byte-identical between 30d and all-time
 * while their sibling KPIs moved. This is the population filter that fixes that.
 *
 * The activity instant is `COALESCE(lastActivityAt, artifact.createdAt)` — the
 * SAME documented bounded fallback the Branches list windows and sorts on
 * (`branchCandidateActivityExpr`, FEA-4311) and the same value the branch read
 * projects as `lastActivityAt`. `BranchDetail.lastActivityAt` is nullable for
 * pre-backfill and session-only branches, and a raw `gte`/`lte` on a nullable
 * column DROPS those rows entirely; the artifact `createdAt` fallback (`@default
 * (now())`, never null) retains them under the window that actually applies to
 * them, rather than silently shrinking the population. Same null-safety
 * rationale as countClosedPrs (FEA-3208).
 *
 * ISS-4634 (review): soft-deleted branches are excluded (`deletedAt: null`) to
 * match the Branches list population (`branchCandidateWhereClause` in
 * `branch-read-service.ts` applies the same `b.deleted_at IS NULL`). A
 * tombstoned branch must not sit in a "health" donut the list would never show.
 * The list additionally requires a valid linked session
 * (`branchCandidateMembershipClause`); this donut deliberately counts EVERY
 * known non-deleted active branch (the broader, defensible health population),
 * and the tooltip copy in `packages/app/insights/lib/metric-info.ts` says so
 * ("every branch we've observed active…") rather than promising the list's
 * narrower session-linked filter.
 */
export function branchActivityWindow(
  start: Date,
  end: Date
): Prisma.BranchDetailWhereInput {
  return {
    deletedAt: null,
    OR: [
      { lastActivityAt: { gte: start, lte: end } },
      {
        lastActivityAt: null,
        artifact: { is: { createdAt: { gte: start, lte: end } } },
      },
    ],
  };
}

export function fetchCheckStatusBuckets(
  organizationId: string,
  start: Date,
  end: Date
): Promise<DonutSlice[]> {
  return withDb((db) =>
    db.branchDetail.groupBy({
      by: ["checksStatus"],
      where: {
        artifact: { organizationId },
        ...branchActivityWindow(start, end),
      },
      _count: { _all: true },
    })
  ).then((rows) =>
    rows.map((row) => ({
      key: row.checksStatus,
      label: CHECK_STATUS_LABELS[row.checksStatus],
      value: row._count._all,
    }))
  );
}

/**
 * The branch-coverage donut ("has a PR" vs "no PR") over the windowed
 * population. `artifactScope` is the caller-resolved artifact-relation scope
 * predicate (org-wide, or authored by the user) — resolved in the composition
 * root and passed in so this module stays free of the scope-context type.
 */
export function fetchBranchesWithoutPrBuckets(
  artifactScope: Prisma.ArtifactWhereInput,
  start: Date,
  end: Date
): Promise<CategoryBucket[]> {
  return withDb(async (db) => {
    // ISS-4634: windowed population, current-state "has a PR" attribute.
    const activeInRange = branchActivityWindow(start, end);
    const [withPr, withoutPr] = await Promise.all([
      db.branchDetail.count({
        where: {
          artifact: artifactScope,
          currentPullRequestDetailId: { not: null },
          ...activeInRange,
        },
      }),
      db.branchDetail.count({
        where: {
          artifact: artifactScope,
          currentPullRequestDetailId: null,
          ...activeInRange,
        },
      }),
    ]);
    return [
      { key: "has-pr", label: "Has a pull request", value: withPr },
      { key: "no-pr", label: "No pull request", value: withoutPr },
    ];
  });
}

const CHECK_STATUS_LABELS: Record<ChecksStatus, string> = {
  [ChecksStatus.PASSING]: "Passing",
  [ChecksStatus.FAILING]: "Failing",
  [ChecksStatus.PENDING]: "Running",
  [ChecksStatus.UNKNOWN]: "Unknown",
};
