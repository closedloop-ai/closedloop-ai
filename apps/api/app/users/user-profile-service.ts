/**
 * Profile and analytics reads for a user (FEA-4064 / FEA-4108).
 *
 * Split out of `service.ts` (ISS-5195): that file owns the user CRUD surface
 * and the public-contract select, and had grown past the size at which one
 * module plausibly has one responsibility. These reads share none of that
 * state — they are range-scoped aggregates and derived widgets, each already
 * independent of the others so a slow or failing widget cannot fail its
 * siblings — so they move together with the helpers and scan caps only they
 * use. Routes import this service directly; `service.ts` does not re-export it.
 */
import type { DocumentType } from "@repo/api/src/types/document";
import { InsightsScope } from "@repo/api/src/types/insights";
import type {
  ContributionDay,
  DocumentsByType,
  UserContributionHeatmap,
  UserMilestone,
  UserProfileHeadline,
  UserProfileMilestones,
  UserProfileStanding,
  UserProfileStats,
  UserStreak,
} from "@repo/api/src/types/user";
import { MilestoneKind } from "@repo/api/src/types/user";
import { ArtifactType, GitHubPRState, Prisma, withDb } from "@repo/database";
import { log } from "@repo/observability/log";
import {
  countDistinctMergedPrsFrom,
  PROJECTED_PR_IDENTITY_SQL,
} from "@/app/insights/merged-pr-queries";
import { orgMergedPullRequestMembershipSql } from "@/lib/pull-request-population";

export const userProfileService = {
  /**
   * Range-scoped headline metrics for the profile header (FEA-4064).
   *
   * This is the ONLY read the profile range toggle re-fetches. It carries every
   * range-dependent number (documents, comments, PRs landed) and is
   * deliberately split from the fixed-window
   * contribution heatmap (`getUserContributionHeatmap`) so a range click never
   * re-issues the trailing-year heatmap SQL, and so a slow/failing heatmap read
   * can never fail this ranged response (widget independence).
   *
   * `startDate` is the inclusive lower bound driven by the toggle; when omitted
   * the totals are all-time, preserving the prior behavior byte-for-byte.
   */
  async getUserProfileHeadline(
    userId: string,
    organizationId: string,
    startDate?: Date
  ): Promise<UserProfileHeadline> {
    try {
      // Shared createdAt lower bound for the ranged aggregates. When startDate
      // is omitted this stays undefined, so each query's createdAt filter is a
      // no-op and the totals remain all-time exactly as before.
      const rangedCreatedAt = startDate ? { gte: startDate } : undefined;

      const [
        totalArtifacts,
        artifactsByTypeRaw,
        totalComments,
        totalPRsLanded,
      ] = await Promise.all([
        // Total document artifacts created
        withDb((db) =>
          db.artifact.count({
            where: {
              createdById: userId,
              organizationId,
              type: ArtifactType.DOCUMENT,
              createdAt: rangedCreatedAt,
            },
          })
        ),
        // Document artifacts grouped by subtype (legacy DocumentType)
        withDb((db) =>
          db.artifact.groupBy({
            by: ["subtype"],
            where: {
              createdById: userId,
              organizationId,
              type: ArtifactType.DOCUMENT,
              createdAt: rangedCreatedAt,
            },
            _count: { id: true },
          })
        ),
        // Total comments authored (org-scoped via thread)
        withDb((db) =>
          db.comment.count({
            where: {
              authorId: userId,
              thread: { organizationId },
              createdAt: rangedCreatedAt,
            },
          })
        ),
        // DISTINCT merged pull requests from the user's branches, windowed by
        // when the PR actually LANDED (mergedAt), not when the branch was
        // created (FEA-4064). Counted on the SAME projected-identity basis and
        // org-merged membership as the Delivery KPI (cr on PR #6112) — one
        // number for one universe: a multi-PR branch lands each PR, a twin
        // projection lands once.
        countDistinctMergedPrsFrom(
          { organizationId, userId, scope: InsightsScope.Me },
          startDate ?? null
        ),
      ]);

      const artifactsByType: DocumentsByType[] = artifactsByTypeRaw.flatMap(
        (row) => {
          if (row.subtype === null) {
            return [];
          }
          return [{ type: row.subtype as DocumentType, count: row._count.id }];
        }
      );

      return {
        totalDocuments: totalArtifacts,
        documentsByType: artifactsByType,
        totalComments,
        totalPRsLanded,
        totalLoops: 0,
        avgConcurrency: 0,
        totalTokensInput: 0,
        totalTokensOutput: 0,
        totalEstimatedCost: 0,
      };
    } catch (error) {
      log.error("[users-service] Failed to get user profile headline", {
        error: error instanceof Error ? error.message : String(error),
        userId,
        organizationId,
      });
      throw error;
    }
  },

  /**
   * Fixed-window contribution heatmap widget (FEA-4064).
   *
   * A heatmap is a trailing-year grid by definition, so this read is NOT scoped
   * by the profile range toggle and takes no startDate. It is split out from the
   * headline query so the toggle never re-issues this SQL, and so a failure here
   * degrades to an empty/error heatmap widget without failing the headline
   * response (widget independence).
   */
  async getUserContributionHeatmap(
    userId: string,
    organizationId: string
  ): Promise<UserContributionHeatmap> {
    try {
      const oneYearAgo = new Date();
      oneYearAgo.setFullYear(oneYearAgo.getFullYear() - 1);

      // Contribution heatmap: document artifact creations over last year,
      // bucketed per-day in the DB so this returns at most ~365 rows instead
      // of one row per artifact (FEA-3501). `created_at` is TIMESTAMP(3)
      // WITHOUT time zone holding UTC instants, so a bare `date_trunc('day',
      // …)` buckets in UTC — matching the UTC day keys the dense enumeration
      // below builds via `toDateKey`.
      const contributionData = await withDb((db) =>
        db.$queryRaw<{ day: string; n: number }[]>(
          Prisma.sql`
              SELECT
                to_char(date_trunc('day', created_at), 'YYYY-MM-DD') AS day,
                COUNT(*)::int AS n
              FROM artifacts
              WHERE created_by_id = ${userId}::uuid
                AND organization_id = ${organizationId}::uuid
                AND "type" = ${ArtifactType.DOCUMENT}::"ArtifactType"
                AND created_at >= ${oneYearAgo}
              GROUP BY day
            `
        )
      );

      return {
        contributionHeatmap: buildContributionHeatmap(contributionData),
      };
    } catch (error) {
      log.error("[users-service] Failed to get user contribution heatmap", {
        error: error instanceof Error ? error.message : String(error),
        userId,
        organizationId,
      });
      throw error;
    }
  },

  /**
   * Full profile statistics (legacy combined shape).
   *
   * Composes the range-scoped headline and the fixed-window heatmap widget so
   * the legacy GET /users/:id/stats route and any older client keep receiving
   * the same combined payload. New surfaces read the two split payloads
   * independently via getUserProfileHeadline / getUserContributionHeatmap.
   */
  async getUserStats(
    userId: string,
    organizationId: string,
    startDate?: Date
  ): Promise<UserProfileStats> {
    const [headline, heatmap] = await Promise.all([
      this.getUserProfileHeadline(userId, organizationId, startDate),
      this.getUserContributionHeatmap(userId, organizationId),
    ]);
    return { ...headline, ...heatmap };
  },

  /**
   * Standing widget payload for the profile (FEA-4108): the user's
   * consecutive-active-days streak.
   *
   * A day is "active" when the user created at least one document artifact that
   * day, the same org-scoped activity the contribution heatmap counts, bucketed
   * per-day in the DB so at most ~one row per active day crosses the wire. The
   * streak is derived over the trailing year (STREAK_SCAN_DAYS) so the read
   * stays bounded; a run longer than the window is reported as the window when
   * it reaches the earliest scanned day. `streak` is null when the user has no
   * active day at all, so the Standing section can stay hidden rather than
   * render a fake zero streak.
   *
   * Rank is intentionally NOT computed here: a global cross-org ranking service
   * is unbuilt (FEA-4122), so no rank field is emitted and the profile renders
   * no rank tile until that lands.
   */
  async getUserProfileStanding(
    userId: string,
    organizationId: string
  ): Promise<UserProfileStanding> {
    try {
      const scanStart = new Date();
      scanStart.setDate(scanStart.getDate() - (STREAK_SCAN_DAYS - 1));

      // Distinct active days (UTC), bucketed in the DB, matching the heatmap's
      // date_trunc('day', created_at) UTC bucketing so the streak and the
      // heatmap agree on what counts as an active day.
      const activeDayRows = await withDb((db) =>
        db.$queryRaw<{ day: string }[]>(
          Prisma.sql`
              SELECT DISTINCT
                to_char(date_trunc('day', created_at), 'YYYY-MM-DD') AS day
              FROM artifacts
              WHERE created_by_id = ${userId}::uuid
                AND organization_id = ${organizationId}::uuid
                AND "type" = ${ArtifactType.DOCUMENT}::"ArtifactType"
                AND created_at >= ${scanStart}
              ORDER BY day
            `
        )
      );

      return { streak: computeStreak(activeDayRows.map((row) => row.day)) };
    } catch (error) {
      log.error("[users-service] Failed to get user profile standing", {
        error: error instanceof Error ? error.message : String(error),
        userId,
        organizationId,
      });
      throw error;
    }
  },

  /**
   * Lifetime milestones/achievements for the profile (FEA-4108).
   *
   * Milestones are lifetime cumulative totals that crossed a threshold: PRs
   * landed and documents created. Each is sourced from existing
   * per-user org-scoped aggregates — no cross-org queries. Only EARNED
   * milestones (a real threshold actually crossed) are returned, so the
   * Milestones section renders nothing rather than a fake empty state when the
   * user has crossed no threshold.
   *
   * `earnedAt` is the timestamp of the activity that put the running total over
   * the threshold (the N-th merged PR's mergedAt / the N-th document's
   * createdAt), so a milestone reflects when it was actually reached.
   */
  async getUserProfileMilestones(
    userId: string,
    organizationId: string
  ): Promise<UserProfileMilestones> {
    try {
      const [prLandedThresholdRows, documentDates] = await Promise.all([
        // PR-landed threshold crossings computed entirely in SQL (Kerensa,
        // cr-96292: SQL-side, not a capped app-side scan). One landing
        // instant per DISTINCT pull request — the projected identity the
        // Delivery KPI dedupes on, so a twin projection lands once and a
        // multi-PR branch lands each PR (cr on PR #6112) — admitted by the
        // SAME org-merged membership as the headline and Insights, ranked
        // in landing order, returning exactly one row per crossed
        // PR_LANDED_THRESHOLDS value. Exact regardless of how many PRs the
        // user has landed; the retired createdAt-ordered scan was only an
        // approximation of landing order past its cap.
        withDb((db) =>
          db.$queryRaw<{ threshold: number; earned_at: Date }[]>(
            Prisma.sql`
                WITH landings AS (
                  SELECT
                    ${PROJECTED_PR_IDENTITY_SQL} AS identity,
                    MIN(p.merged_at) AS landed_at
                  FROM pull_request_detail p
                  JOIN artifacts a ON a.id = p.branch_artifact_id
                  LEFT JOIN github_installation_repositories pr_repository
                    ON pr_repository.id = p.repository_id
                  WHERE a.organization_id = ${organizationId}::uuid
                    AND a.type = ${ArtifactType.BRANCH}::"ArtifactType"
                    AND a.created_by_id = ${userId}::uuid
                    AND p.pr_state = ${GitHubPRState.MERGED}::"GitHubPRState"
                    AND p.merged_at IS NOT NULL
                    AND ${orgMergedPullRequestMembershipSql(organizationId)}
                  GROUP BY 1
                ),
                ordered AS (
                  SELECT
                    landed_at,
                    ROW_NUMBER() OVER (ORDER BY landed_at, identity) AS n
                  FROM landings
                ),
                thresholds AS (
                  SELECT UNNEST(${Prisma.sql`ARRAY[${Prisma.join([
                    ...PR_LANDED_THRESHOLDS,
                  ])}]::int[]`}) AS threshold
                )
                SELECT t.threshold::int AS threshold, o.landed_at AS earned_at
                FROM thresholds t
                JOIN ordered o ON o.n = t.threshold
                ORDER BY t.threshold
              `
          )
        ),
        // Creation timestamps of the user's document artifacts, oldest-first and
        // capped, so the N-th entry is when the user reached N lifetime docs.
        withDb((db) =>
          db.artifact.findMany({
            where: {
              createdById: userId,
              organizationId,
              type: ArtifactType.DOCUMENT,
            },
            select: { createdAt: true },
            orderBy: { createdAt: "asc" },
            take: MILESTONE_SCAN_CAP,
          })
        ),
      ]);

      const milestones: UserMilestone[] = [];
      milestones.push(
        ...earnedCrossingMilestones(
          MilestoneKind.PrsLanded,
          prLandedThresholdRows
        ),
        ...earnedThresholdMilestones(
          MilestoneKind.DocumentsCreated,
          DOCUMENTS_THRESHOLDS,
          documentDates.map((row) => row.createdAt)
        )
      );

      // Newest-earned first so the freshest achievement leads the list.
      milestones.sort((a, b) => b.earnedAt.getTime() - a.earnedAt.getTime());

      return { milestones };
    } catch (error) {
      log.error("[users-service] Failed to get user profile milestones", {
        error: error instanceof Error ? error.message : String(error),
        userId,
        organizationId,
      });
      throw error;
    }
  },
};

/** Format a Date as YYYY-MM-DD using UTC date parts. */
function toDateKey(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/**
 * Build a dense 52-week contribution heatmap from per-day counts already
 * aggregated by the database (`day` is a UTC `YYYY-MM-DD` key).
 */
function buildContributionHeatmap(
  rows: { day: string; n: number }[]
): ContributionDay[] {
  const countsByDate = new Map(rows.map((row) => [row.day, row.n]));

  const result: ContributionDay[] = [];
  const today = new Date();
  const totalDays = 364; // 52 weeks
  for (let i = totalDays - 1; i >= 0; i--) {
    const d = new Date(today);
    d.setDate(d.getDate() - i);
    const key = toDateKey(d);
    result.push({ date: key, count: countsByDate.get(key) ?? 0 });
  }
  return result;
}

// Trailing-year window for the consecutive-active-days streak scan (FEA-4108).
// Bounds the distinct-active-days read the same way the heatmap is bounded; a
// run longer than this window is reported as the window once it reaches the
// earliest scanned day.
export const STREAK_SCAN_DAYS = 366;

// Upper bound on the per-user ordered document-created timestamp read that
// backs the documents milestone (FEA-4108). The largest threshold is the only
// value the milestone logic needs beyond, so this cap comfortably covers every
// threshold while keeping the read bounded for prolific users. The PR-landed
// milestone computes its crossings in SQL and needs no cap.
export const MILESTONE_SCAN_CAP = 20_000;

// Lifetime thresholds a cumulative total crosses to earn a milestone
// (FEA-4108). Ascending; every crossed threshold earns its own milestone.
export const PR_LANDED_THRESHOLDS = [10, 50, 100, 250, 500, 1000] as const;
export const DOCUMENTS_THRESHOLDS = [10, 50, 100, 250, 500, 1000] as const;

/**
 * Compute the current and best consecutive-active-days streak from a sorted
 * (ascending) list of distinct active-day UTC keys (`YYYY-MM-DD`).
 *
 * Returns null when there are no active days, so the caller can hide the
 * Standing section rather than render a fake zero streak. The current streak
 * counts the run ending today OR yesterday (a day mid-flight has not broken the
 * streak yet); a gap of two or more days ends the current run.
 */
function computeStreak(activeDayKeys: string[]): UserStreak | null {
  if (activeDayKeys.length === 0) {
    return null;
  }

  const days = activeDayKeys.map((key) => dayKeyToUtcIndex(key));
  days.sort((a, b) => a - b);

  let bestDays = 1;
  let run = 1;
  for (let i = 1; i < days.length; i++) {
    run = days[i] - days[i - 1] === 1 ? run + 1 : 1;
    if (run > bestDays) {
      bestDays = run;
    }
  }

  const todayIndex = dayKeyToUtcIndex(toDateKey(new Date()));
  const lastActive = days.at(-1) ?? todayIndex;
  const gapFromToday = todayIndex - lastActive;

  // The run only counts as "current" when its latest day is today or yesterday;
  // a two-day-or-larger gap means the streak has already broken.
  let currentDays = 0;
  if (gapFromToday <= 1) {
    currentDays = 1;
    for (let i = days.length - 1; i > 0; i--) {
      if (days[i] - days[i - 1] === 1) {
        currentDays++;
      } else {
        break;
      }
    }
  }

  return { currentDays, bestDays };
}

/** Convert a `YYYY-MM-DD` UTC day key to an integer day index (days since
 * epoch), so consecutive days differ by exactly 1. */
function dayKeyToUtcIndex(key: string): number {
  const ms = Date.parse(`${key}T00:00:00Z`);
  return Math.floor(ms / (24 * 60 * 60 * 1000));
}

/**
 * Emit one milestone per crossed threshold for an ascending list of the
 * timestamps at which the cumulative count reached 1, 2, 3, … . The N-th
 * timestamp is when the user reached a lifetime total of N, so a threshold T is
 * earned at `timestamps[T - 1]`. Only thresholds actually crossed are emitted.
 */
function earnedThresholdMilestones(
  kind: MilestoneKind,
  thresholds: readonly number[],
  timestamps: (Date | null)[]
): UserMilestone[] {
  const total = timestamps.length;
  const out: UserMilestone[] = [];
  for (const threshold of thresholds) {
    if (total < threshold) {
      break;
    }
    const earnedAt = timestamps[threshold - 1];
    if (earnedAt) {
      out.push({ kind, threshold, earnedAt });
    }
  }
  return out;
}

/**
 * Map SQL-computed threshold crossings (the PR-landed query above) to
 * milestones. Each row is a crossed threshold value plus the timestamp of
 * the activity that first pushed the lifetime total to or past it. The
 * threshold-crossing walk itself is done in SQL, so this is a straight map.
 */
function earnedCrossingMilestones(
  kind: MilestoneKind,
  rows: { threshold: number | bigint; earned_at: Date }[]
): UserMilestone[] {
  return rows.map((row) => ({
    kind,
    threshold: Number(row.threshold),
    earnedAt: row.earned_at,
  }));
}
