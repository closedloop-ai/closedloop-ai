import type { ArtifactSubtype } from "@repo/api/src/types/artifact";
import type { CaseScore, JudgesReport } from "@repo/api/src/types/evaluation";
import type {
  ArtifactCountBucket,
  ArtifactCountsGroupBy,
  ArtifactCountsResponse,
  ArtifactSubtypeGroup,
  JudgeAggregateStats,
  JudgeStatsResponse,
} from "@repo/api/src/types/judges-analytics";
import { withDb } from "@repo/database";

/** Validates and extracts a JudgesReport from unknown reportData. Returns null if invalid. */
function parseJudgesReport(reportData: unknown): JudgesReport | null {
  if (
    !(reportData && typeof reportData === "object" && "stats" in reportData)
  ) {
    return null;
  }
  const report = reportData as JudgesReport;
  return report?.stats && Array.isArray(report.stats) ? report : null;
}

/** Extracts judge name and score from a CaseScore. Returns null if no matching metric. */
function extractJudgeMetric(
  caseScore: CaseScore
): { name: string; score: number } | null {
  const judgeName = caseScore.case_id;
  const judgeMetric = caseScore.metrics?.find(
    (metric) => metric.metric_name === caseScore.case_id
  );
  return judgeMetric ? { name: judgeName, score: judgeMetric.score } : null;
}

/** Aggregates judge scores by artifact subtype and judge name. */
class JudgeScoreAggregator {
  private readonly data = new Map<
    ArtifactSubtype,
    Map<string, { scores: number[]; artifactIds: Set<string> }>
  >();

  addScore(
    artifactSubtype: ArtifactSubtype,
    judgeName: string,
    score: number,
    artifactId: string
  ): void {
    if (!this.data.has(artifactSubtype)) {
      this.data.set(artifactSubtype, new Map());
    }

    const judgeMap = this.data.get(artifactSubtype)!;
    if (!judgeMap.has(judgeName)) {
      judgeMap.set(judgeName, { scores: [], artifactIds: new Set() });
    }

    const judgeData = judgeMap.get(judgeName)!;
    judgeData.scores.push(score);
    judgeData.artifactIds.add(artifactId);
  }

  getResults(): Map<
    ArtifactSubtype,
    Map<string, { scores: number[]; artifactIds: Set<string> }>
  > {
    return this.data;
  }
}

type EvaluationInput = {
  artifactId: string;
  artifact: { subtype: ArtifactSubtype };
  reportData: unknown;
};

/**
 * Extracts judge scores from evaluation reportData and aggregates them by artifact subtype and judge name.
 *
 * @param evaluations - Array of artifact evaluations with their artifact subtype
 * @returns Nested map structure: artifactSubtype -> judgeName -> { scores, artifactIds }
 */
function extractJudgeScores(
  evaluations: EvaluationInput[]
): Map<
  ArtifactSubtype,
  Map<string, { scores: number[]; artifactIds: Set<string> }>
> {
  const aggregator = new JudgeScoreAggregator();

  for (const evaluation of evaluations) {
    const report = parseJudgesReport(evaluation.reportData);
    if (!report) {
      continue;
    }

    for (const caseScore of report.stats) {
      const metric = extractJudgeMetric(caseScore);
      if (!metric) {
        continue;
      }

      aggregator.addScore(
        evaluation.artifact.subtype,
        metric.name,
        metric.score,
        evaluation.artifactId
      );
    }
  }

  return aggregator.getResults();
}

/** getUTCDay() returns 0 for Sunday; ISO week starts on Monday. */
const SUNDAY_INDEX = 0;
/** Days from Sunday back to the previous Monday. */
const ISO_WEEK_OFFSET_FROM_SUNDAY = -6;

function formatDateKey(year: number, month: number, day: number): string {
  return `${year}-${String(month + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

function getISOWeekStartDate(date: Date): Date {
  const dow = date.getUTCDay();
  const mondayOffset =
    dow === SUNDAY_INDEX ? ISO_WEEK_OFFSET_FROM_SUNDAY : 1 - dow;
  return new Date(
    Date.UTC(
      date.getUTCFullYear(),
      date.getUTCMonth(),
      date.getUTCDate() + mondayOffset
    )
  );
}

/**
 * Aggregation service for judges analytics.
 *
 * Queries ArtifactEvaluation records within a date range, extracts judge scores
 * from the reportData JSON, and computes aggregate statistics (min, mean, max, stdDev)
 * grouped by artifact subtype and judge name.
 */
export const judgesAnalyticsService = {
  /**
   * Get aggregate statistics for all judges within a date range.
   *
   * @param organizationId - Organization ID to scope the query
   * @param startDate - Start date (inclusive)
   * @param endDate - End date (inclusive)
   * @returns Aggregate statistics grouped by artifact subtype and judge name
   */
  async getAggregateStats(
    organizationId: string,
    startDate: Date,
    endDate: Date
  ): Promise<JudgeStatsResponse> {
    // Query ArtifactEvaluation records with artifact subtype, filtered by date range and organization
    const evaluations = await withDb((db) =>
      db.artifactEvaluation.findMany({
        where: {
          artifact: {
            organizationId,
          },
          createdAt: {
            gte: startDate,
            lte: endDate,
          },
        },
        select: {
          artifactId: true,
          reportData: true,
          artifact: { select: { subtype: true } },
        },
        orderBy: {
          createdAt: "desc",
        },
      })
    );

    // Extract scores from reportData JSON using the "metric_name === case_id" rule
    const aggregator = extractJudgeScores(evaluations);

    // Compute statistics for each judge within each artifact subtype
    const groups: ArtifactSubtypeGroup[] = [];

    for (const [artifactSubtype, judgeMap] of aggregator) {
      const judges: JudgeAggregateStats[] = [];

      for (const [judgeName, judgeData] of judgeMap) {
        const scores = judgeData.scores;
        const count = scores.length;
        const artifactsEvaluated = judgeData.artifactIds.size;

        if (count === 0) {
          continue;
        }

        const min = Math.min(...scores);
        const max = Math.max(...scores);
        const sum = scores.reduce((acc, score) => acc + score, 0);
        const mean = sum / count;

        // Compute standard deviation
        const variance =
          scores.reduce((acc, score) => acc + (score - mean) ** 2, 0) / count;
        const stdDev = Math.sqrt(variance);

        judges.push({
          judgeName,
          artifactsEvaluated,
          min,
          mean,
          max,
          stdDev,
        });
      }

      // Sort judges by mean score in descending order (highest mean first)
      judges.sort((a, b) => b.mean - a.mean);

      groups.push({
        artifactSubtype,
        judges,
      });
    }

    return { groups };
  },

  /**
   * Get artifact creation counts grouped by time bucket and artifact subtype.
   * Uses findMany + in-memory grouping so it works with any Prisma schema/adapter.
   *
   * @param organizationId - Organization ID to scope the query
   * @param startDate - Start date (inclusive)
   * @param endDate - End date (inclusive)
   * @param groupBy - Time bucket: "day", "week", or "month"
   * @returns Buckets with ISO date string (start of period) and countsBySubtype
   */
  async getArtifactCounts(
    organizationId: string,
    startDate: Date,
    endDate: Date,
    groupBy: ArtifactCountsGroupBy
  ): Promise<ArtifactCountsResponse> {
    const artifacts = await withDb((db) =>
      db.artifact.findMany({
        where: {
          organizationId,
          createdAt: { gte: startDate, lte: endDate },
        },
        select: { createdAt: true, subtype: true },
      })
    );

    const bucketKey = (d: Date): string => {
      const date = new Date(d);
      const y = date.getUTCFullYear();
      const m = date.getUTCMonth();
      const day = date.getUTCDate();

      switch (groupBy) {
        case "day":
          return formatDateKey(y, m, day);
        case "month":
          return formatDateKey(y, m, 1);
        case "week": {
          const monday = getISOWeekStartDate(date);
          return formatDateKey(
            monday.getUTCFullYear(),
            monday.getUTCMonth(),
            monday.getUTCDate()
          );
        }
        default:
          throw new Error(`Unknown groupBy value: ${groupBy}`);
      }
    };

    const bucketSubtypeCounts = new Map<string, Map<string, number>>();
    for (const { createdAt, subtype } of artifacts) {
      const key = bucketKey(createdAt);
      if (!bucketSubtypeCounts.has(key)) {
        bucketSubtypeCounts.set(key, new Map());
      }
      const subtypeMap = bucketSubtypeCounts.get(key)!;
      const subtypeStr = subtype;
      subtypeMap.set(subtypeStr, (subtypeMap.get(subtypeStr) ?? 0) + 1);
    }

    const buckets: ArtifactCountBucket[] = [...bucketSubtypeCounts.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([bucket, subtypeMap]) => {
        const countsBySubtype: Record<string, number> = {};
        for (const [subtype, count] of subtypeMap) {
          if (count > 0) {
            countsBySubtype[subtype] = count;
          }
        }
        return { bucket, countsBySubtype };
      });
    return { buckets };
  },
};
