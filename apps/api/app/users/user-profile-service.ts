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
import { LoopStatus } from "@repo/api/src/types/loop";
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

// Average loop concurrency (see computeAvgLoopConcurrency) is derived by
// materializing a user's loops and running an O(n²) interval-overlap scan, so
// the read must stay bounded for heavy users. Like the contribution heatmap it
// is scoped to the trailing year (`startedAt >= oneYearAgo`) and additionally
// capped to the most recent LOOP_CONCURRENCY_SCAN_CAP rows (newest-first) so
// both the memory footprint and the quadratic scan stay bounded regardless of
// how many loops a user has started. This is an approximate KPI, so degrading
// to the most recent window past the cap is acceptable; a sweep-line rewrite of
// the overlap scan is tracked separately as a perf follow-on (FEA-3500). A
// supporting (organizationId, userId, startedAt) index for this
// startedAt-ordered/range-scanned read is likewise tracked separately (the
// existing (organizationId, userId, createdAt) index already keeps the scan
// org+user-selective); adding the migration here is deferred, mirroring the
// MERGED_PR_SCAN_CAP index note in insights/merged-pr-queries.ts.
export const LOOP_CONCURRENCY_SCAN_CAP = 10_000;

export const userProfileService = {
  /**
   * Range-scoped headline metrics for the profile header (FEA-4064).
   *
   * This is the ONLY read the profile range toggle re-fetches. It carries every
   * range-dependent number (documents, comments, PRs landed, loops, tokens,
   * cost, avg loop concurrency) and is deliberately split from the fixed-window
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
      const oneYearAgo = new Date();
      oneYearAgo.setFullYear(oneYearAgo.getFullYear() - 1);

      // Shared createdAt lower bound for the ranged aggregates. When startDate
      // is omitted this stays undefined, so each query's createdAt filter is a
      // no-op and the totals remain all-time exactly as before.
      const rangedCreatedAt = startDate ? { gte: startDate } : undefined;

      // Lower bound applied to the PR's own merge time for "PRs Landed" — the PR
      // lands in the window it MERGED in, independent of when its branch artifact
      // was created (FEA-4064). Undefined when all-time, same no-op semantics.
      const rangedMergedAt = startDate ? { gte: startDate } : undefined;

      // Lower bound for the O(n²) concurrency scan. It must stay windowed so the
      // quadratic overlap scan stays bounded, so it never widens past the trailing
      // year; when a range narrower than a year is selected it tightens to that
      // range so Avg Loop Concurrency reflects the SAME window as its label rather
      // than a trailing-year value (FEA-4064). Ranges are 30d/90d/1y, all ≥
      // oneYearAgo, so `startDate` (when present) is always the tighter bound.
      const concurrencyStartedAtFloor =
        startDate && startDate > oneYearAgo ? startDate : oneYearAgo;

      const [
        totalArtifacts,
        artifactsByTypeRaw,
        totalComments,
        totalPRsLanded,
        totalLoops,
        loopConcurrencyData,
        loopTokenAggregate,
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
        // Merged branches with current PR evidence created by the user, windowed
        // by when the PR actually LANDED (currentPullRequestDetail.mergedAt), not
        // when the branch artifact was created (FEA-4064). A branch cut months ago
        // but merged inside the selected window is a landing in that window; the
        // Insights "PRs Landed" KPI windows on this same mergedAt field. Served by
        // the (organizationId, prState, mergedAt) index on PullRequestDetail.
        withDb((db) =>
          db.artifact.count({
            where: {
              organizationId,
              type: ArtifactType.BRANCH,
              createdById: userId,
              branch: {
                currentPullRequestDetail: {
                  prState: GitHubPRState.MERGED,
                  mergedAt: rangedMergedAt,
                },
              },
            },
          })
        ),
        // Total loops initiated
        withDb((db) =>
          db.loop.count({
            where: { userId, organizationId, createdAt: rangedCreatedAt },
          })
        ),
        // Loop concurrency: loops with timing data. Bounded to the selected
        // window (or the trailing year when all-time) and the most recent
        // LOOP_CONCURRENCY_SCAN_CAP rows (newest-first) so the O(n²) overlap scan
        // stays bounded for heavy users, mirroring how the contribution heatmap
        // read is windowed (FEA-3500). The lower bound is `concurrencyStartedAtFloor`
        // so 30d/90d show a window-matching average rather than a trailing-year
        // value under the selected-window label (FEA-4064). `startedAt >= floor`
        // also preserves the prior "has timing data" filter, since a null
        // startedAt cannot satisfy the lower bound.
        withDb((db) =>
          db.loop.findMany({
            where: {
              userId,
              organizationId,
              startedAt: { gte: concurrencyStartedAtFloor },
            },
            select: { startedAt: true, completedAt: true, status: true },
            orderBy: { startedAt: "desc" },
            take: LOOP_CONCURRENCY_SCAN_CAP,
          })
        ),
        // Loop token/cost totals
        withDb((db) =>
          db.loop.aggregate({
            where: { userId, organizationId, createdAt: rangedCreatedAt },
            _sum: {
              tokensInput: true,
              tokensOutput: true,
              estimatedCost: true,
            },
          })
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

      const avgConcurrency = computeAvgLoopConcurrency(loopConcurrencyData);

      return {
        totalDocuments: totalArtifacts,
        documentsByType: artifactsByType,
        totalComments,
        totalPRsLanded,
        totalLoops,
        avgConcurrency,
        totalTokensInput: loopTokenAggregate._sum.tokensInput ?? 0,
        totalTokensOutput: loopTokenAggregate._sum.tokensOutput ?? 0,
        totalEstimatedCost: Number(loopTokenAggregate._sum.estimatedCost ?? 0),
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
   * landed, documents created, and tokens used. Each is sourced from existing
   * per-user org-scoped aggregates — no cross-org queries. Only EARNED
   * milestones (a real threshold actually crossed) are returned, so the
   * Milestones section renders nothing rather than a fake empty state when the
   * user has crossed no threshold.
   *
   * `earnedAt` is the timestamp of the activity that put the running total over
   * the threshold (the N-th merged PR's mergedAt / the N-th document's
   * createdAt / the completion of the loop whose tokens first pushed the
   * cumulative total over the mark), so a milestone reflects when it was
   * actually reached. Token crossings use loop completion — not creation —
   * because tokens accrue during a run, so a run spanning midnight would
   * otherwise be credited before its tokens existed.
   */
  async getUserProfileMilestones(
    userId: string,
    organizationId: string
  ): Promise<UserProfileMilestones> {
    try {
      const [prLandedRows, documentDates, tokenThresholdRows] =
        await Promise.all([
          // Merge timestamps of the user's landed PRs, oldest-first and capped, so
          // the N-th entry is when the user reached N lifetime landed PRs. Counted
          // as BRANCH artifacts whose CURRENT PR detail merged — the same dedupe
          // identity the headline "PRs landed" count uses (one branch = one
          // landing). Counting PullRequestDetail rows directly would double-count a
          // branch that has more than one merged PR-detail row (re-projected /
          // re-fetched history), diverging from the headline.
          withDb((db) =>
            db.artifact.findMany({
              where: {
                organizationId,
                type: ArtifactType.BRANCH,
                createdById: userId,
                branch: {
                  currentPullRequestDetail: {
                    prState: GitHubPRState.MERGED,
                    mergedAt: { not: null },
                  },
                },
              },
              select: {
                branch: {
                  select: {
                    currentPullRequestDetail: { select: { mergedAt: true } },
                  },
                },
              },
              // The branch's landing time is its current PR detail's mergedAt.
              orderBy: {
                branch: { currentPullRequestDetail: { mergedAt: "asc" } },
              },
              take: MILESTONE_SCAN_CAP,
            })
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
          // Token-threshold crossings computed entirely in SQL: a window running
          // a cumulative token sum over the user's loops in completion order, from
          // which we return exactly one row per crossed TOKEN_THRESHOLDS value —
          // the loop whose completion first pushed the lifetime total to or past
          // that threshold. This returns at most TOKEN_THRESHOLDS.length rows
          // regardless of how many loops the user has, so the read does not grow
          // with lifetime activity. The crossing timestamp is COALESCE(completed_at,
          // created_at): tokens are the loop's final totals, updated as the run
          // executes, so completion is when the total was actually reached —
          // created_at would credit a midnight-crossing run before it happened.
          withDb((db) =>
            db.$queryRaw<{ threshold: number; earned_at: Date }[]>(
              Prisma.sql`
                WITH cumulative AS (
                  SELECT
                    COALESCE(completed_at, created_at) AS ts,
                    SUM(tokens_input + tokens_output) OVER (
                      ORDER BY COALESCE(completed_at, created_at), id
                      ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
                    ) AS running_total
                  FROM loops
                  WHERE user_id = ${userId}::uuid
                    AND organization_id = ${organizationId}::uuid
                    AND (tokens_input + tokens_output) > 0
                ),
                thresholds AS (
                  SELECT UNNEST(${Prisma.sql`ARRAY[${Prisma.join([
                    ...TOKEN_THRESHOLDS,
                  ])}]::bigint[]`}) AS threshold
                )
                SELECT
                  t.threshold::bigint AS threshold,
                  MIN(c.ts) AS earned_at
                FROM thresholds t
                JOIN cumulative c ON c.running_total >= t.threshold
                GROUP BY t.threshold
                ORDER BY t.threshold
              `
            )
          ),
        ]);

      const milestones: UserMilestone[] = [];
      milestones.push(
        ...earnedThresholdMilestones(
          MilestoneKind.PrsLanded,
          PR_LANDED_THRESHOLDS,
          prLandedRows.map(
            (row) => row.branch?.currentPullRequestDetail?.mergedAt ?? null
          )
        ),
        ...earnedThresholdMilestones(
          MilestoneKind.DocumentsCreated,
          DOCUMENTS_THRESHOLDS,
          documentDates.map((row) => row.createdAt)
        ),
        ...earnedTokenMilestones(tokenThresholdRows)
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

/**
 * Compute average loop concurrency: when this user has a loop running,
 * how many loops are they running simultaneously on average?
 *
 * For each loop's start time, counts how many other loops overlapped,
 * then averages those counts.
 */
const TERMINAL_LOOP_STATUSES = new Set<string>([
  LoopStatus.Completed,
  LoopStatus.Failed,
  LoopStatus.Cancelled,
  LoopStatus.TimedOut,
]);

function computeAvgLoopConcurrency(
  loops: {
    startedAt: Date | null;
    completedAt: Date | null;
    status: string;
  }[]
): number {
  const now = new Date();

  const intervals = loops
    .filter((l): l is typeof l & { startedAt: Date } => l.startedAt !== null)
    .map((l) => ({
      start: l.startedAt,
      end:
        TERMINAL_LOOP_STATUSES.has(l.status) && l.completedAt
          ? l.completedAt
          : now,
    }));

  if (intervals.length === 0) {
    return 0;
  }

  let totalConcurrent = 0;
  for (const point of intervals) {
    let concurrent = 0;
    for (const interval of intervals) {
      if (interval.start <= point.start && interval.end >= point.start) {
        concurrent++;
      }
    }
    totalConcurrent += concurrent;
  }

  return Math.round((totalConcurrent / intervals.length) * 10) / 10;
}

// Trailing-year window for the consecutive-active-days streak scan (FEA-4108).
// Bounds the distinct-active-days read the same way the heatmap is bounded; a
// run longer than this window is reported as the window once it reaches the
// earliest scanned day.
export const STREAK_SCAN_DAYS = 366;

// Upper bound on the per-user ordered timestamp reads that back the lifetime
// milestone thresholds (FEA-4108). The largest threshold is the only value the
// milestone logic needs beyond, so this cap comfortably covers every threshold
// while keeping the read bounded for prolific users.
export const MILESTONE_SCAN_CAP = 20_000;

// Lifetime thresholds a cumulative total crosses to earn a milestone
// (FEA-4108). Ascending; every crossed threshold earns its own milestone.
export const PR_LANDED_THRESHOLDS = [10, 50, 100, 250, 500, 1000] as const;
export const DOCUMENTS_THRESHOLDS = [10, 50, 100, 250, 500, 1000] as const;
export const TOKEN_THRESHOLDS = [
  1_000_000, 10_000_000, 100_000_000, 1_000_000_000, 10_000_000_000,
] as const;

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
 * Map the SQL-computed token-threshold crossings to milestones. Each row is a
 * crossed TOKEN_THRESHOLDS value plus the completion timestamp of the loop that
 * first pushed the lifetime total to or past it (see the query above). The
 * threshold-crossing walk itself is done in SQL, so this is a straight map.
 */
function earnedTokenMilestones(
  tokenThresholdRows: { threshold: number | bigint; earned_at: Date }[]
): UserMilestone[] {
  return tokenThresholdRows.map((row) => ({
    kind: MilestoneKind.TokensUsed,
    threshold: Number(row.threshold),
    earnedAt: row.earned_at,
  }));
}
