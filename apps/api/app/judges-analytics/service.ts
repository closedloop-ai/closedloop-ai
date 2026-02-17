import type { ArtifactType } from "@repo/api/src/types/artifact";
import type { CaseScore, JudgesReport } from "@repo/api/src/types/evaluation";
import type {
  ArtifactCountBucket,
  ArtifactCountsGroupBy,
  ArtifactCountsResponse,
  ArtifactTypeGroup,
  JudgeAggregateStats,
  JudgeStatsResponse,
} from "@repo/api/src/types/judges-analytics";
import { withDb } from "@repo/database";
import { log } from "@repo/observability/log";

/**
 * Regex pattern to match and remove judge/score suffixes from judge names.
 * Matches: -judge, _judge, _score, -score
 */
const JUDGE_SUFFIX_PATTERN = /(-judge|_judge|_score|-score)$/;

/**
 * Normalizes judge names to a canonical stem format.
 *
 * Handles both case_id and metric_name conventions by:
 * 1. Converting to lowercase
 * 2. Removing trailing suffixes: -judge, _judge, _score, -score
 * 3. Converting remaining hyphens to underscores
 *
 * Examples:
 * - "clarity-judge" → "clarity"
 * - "brevity_judge" → "brevity"
 * - "Clarity-Judge" → "clarity"
 * - "clarity_score" → "clarity"
 *
 * @param name - The judge name to normalize (from case_id or metric_name)
 * @returns The canonical stem (lowercase, underscores, no suffix)
 */
export function normalizeJudgeName(name: string): string {
  return name
    .toLowerCase()
    .replace(JUDGE_SUFFIX_PATTERN, "")
    .replaceAll("-", "_");
}

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
  const normalizedCaseId = normalizeJudgeName(caseScore.case_id);
  const judgeMetric = caseScore.metrics?.find(
    (metric) => normalizeJudgeName(metric.metric_name) === normalizedCaseId
  );
  return judgeMetric ? { name: judgeName, score: judgeMetric.score } : null;
}

/** Aggregates judge scores by artifact type and judge name. */
class JudgeScoreAggregator {
  private readonly data = new Map<
    ArtifactType,
    Map<string, { scores: number[]; artifactIds: Set<string> }>
  >();

  addScore(
    artifactType: ArtifactType,
    judgeName: string,
    score: number,
    artifactId: string
  ): void {
    if (!this.data.has(artifactType)) {
      this.data.set(artifactType, new Map());
    }

    const judgeMap = this.data.get(artifactType)!;
    if (!judgeMap.has(judgeName)) {
      judgeMap.set(judgeName, { scores: [], artifactIds: new Set() });
    }

    const judgeData = judgeMap.get(judgeName)!;
    judgeData.scores.push(score);
    judgeData.artifactIds.add(artifactId);
  }

  getResults(): Map<
    ArtifactType,
    Map<string, { scores: number[]; artifactIds: Set<string> }>
  > {
    return this.data;
  }
}

export type EvaluationInput = {
  artifactId: string;
  artifact: { type: ArtifactType };
  reportData: unknown;
};

/**
 * Extracts judge scores from evaluation reportData and aggregates them by artifact type and judge name.
 *
 * @param evaluations - Array of artifact evaluations with their artifact type
 * @returns Nested map structure: artifactType -> judgeName -> { scores, artifactIds }
 */
export function extractJudgeScores(
  evaluations: EvaluationInput[]
): Map<
  ArtifactType,
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
        evaluation.artifact.type,
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
 * Fetches human ratings and comments counts per artifact type (same org and date range).
 * Returns maps with 0 for each type when there are no artifacts or no feedback.
 *
 * @internal Exported for unit testing.
 */
export async function getHumanCountsByType(
  organizationId: string,
  startDate: Date,
  endDate: Date,
  types: ArtifactType[]
): Promise<{
  humanRatingsByType: Map<ArtifactType, number>;
  humanCommentsByType: Map<ArtifactType, number>;
}> {
  const humanRatingsByType = new Map<ArtifactType, number>();
  const humanCommentsByType = new Map<ArtifactType, number>();

  for (const type of types) {
    humanRatingsByType.set(type, 0);
    humanCommentsByType.set(type, 0);
  }

  if (types.length === 0) {
    return { humanRatingsByType, humanCommentsByType };
  }

  const artifacts = await withDb((db) =>
    db.artifact.findMany({
      where: {
        organizationId,
        type: { in: types },
      },
      select: { id: true, type: true },
    })
  );

  const idToType = new Map(artifacts.map((a) => [a.id, a.type] as const));
  const orgArtifactIds = artifacts.map((a) => a.id);

  if (orgArtifactIds.length === 0) {
    return { humanRatingsByType, humanCommentsByType };
  }

  const ratings = await withDb((db) =>
    db.artifactRating.findMany({
      where: {
        artifactId: { in: orgArtifactIds },
        createdAt: { gte: startDate, lte: endDate },
      },
      select: { artifactId: true, comment: true },
    })
  );

  for (const r of ratings) {
    const type = idToType.get(r.artifactId);
    if (type !== undefined) {
      humanRatingsByType.set(type, (humanRatingsByType.get(type) ?? 0) + 1);
      if (r.comment != null && r.comment.trim() !== "") {
        humanCommentsByType.set(type, (humanCommentsByType.get(type) ?? 0) + 1);
      }
    }
  }

  return { humanRatingsByType, humanCommentsByType };
}

/**
 * Aggregation service for judges analytics.
 *
 * Queries ArtifactEvaluation records within a date range, extracts judge scores
 * from the reportData JSON, and computes aggregate statistics (min, mean, max, stdDev)
 * grouped by artifact type and judge name.
 */
export const judgesAnalyticsService = {
  /**
   * Get aggregate statistics for all judges within a date range.
   *
   * @param organizationId - Organization ID to scope the query
   * @param startDate - Start date (inclusive)
   * @param endDate - End date (inclusive)
   * @returns Aggregate statistics grouped by artifact type and judge name
   */
  async getAggregateStats(
    organizationId: string,
    startDate: Date,
    endDate: Date
  ): Promise<JudgeStatsResponse> {
    // Query ArtifactEvaluation records with artifact type, filtered by date range and organization
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
          artifact: { select: { type: true } },
        },
        orderBy: {
          createdAt: "desc",
        },
      })
    );

    if (evaluations.length === 0) {
      log.warn("No evaluations found for judges analytics query", {
        organizationId,
        startDate: startDate.toISOString(),
        endDate: endDate.toISOString(),
      });
    }

    // Extract scores from reportData JSON using the "metric_name === case_id" rule
    const aggregator = extractJudgeScores(evaluations);

    const types = Array.from(aggregator.keys());
    const { humanRatingsByType, humanCommentsByType } =
      await getHumanCountsByType(organizationId, startDate, endDate, types);

    // Compute statistics for each judge within each artifact type
    const groups: ArtifactTypeGroup[] = [];

    for (const [artifactType, judgeMap] of aggregator) {
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
        artifactType,
        judges,
        humanRatingsCount: humanRatingsByType.get(artifactType) ?? 0,
        humanCommentsCount: humanCommentsByType.get(artifactType) ?? 0,
      });
    }

    if (groups.length === 0 && evaluations.length > 0) {
      log.warn(
        "No judge score groups extracted despite having evaluations - possible reportData format issue",
        {
          organizationId,
          evaluationCount: evaluations.length,
          startDate: startDate.toISOString(),
          endDate: endDate.toISOString(),
        }
      );
    }

    return { groups };
  },

  /**
   * Get artifact creation counts grouped by time bucket and artifact type.
   * Uses findMany + in-memory grouping so it works with any Prisma schema/adapter.
   *
   * @param organizationId - Organization ID to scope the query
   * @param startDate - Start date (inclusive)
   * @param endDate - End date (inclusive)
   * @param groupBy - Time bucket: "day", "week", or "month"
   * @returns Buckets with ISO date string (start of period) and countsByType
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
        select: { createdAt: true, type: true },
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

    const bucketTypeCounts = new Map<string, Map<string, number>>();
    for (const { createdAt, type } of artifacts) {
      const key = bucketKey(createdAt);
      if (!bucketTypeCounts.has(key)) {
        bucketTypeCounts.set(key, new Map());
      }
      const typeMap = bucketTypeCounts.get(key)!;
      const typeStr = type;
      typeMap.set(typeStr, (typeMap.get(typeStr) ?? 0) + 1);
    }

    const buckets: ArtifactCountBucket[] = [...bucketTypeCounts.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([bucket, typeMap]) => {
        const countsByType: Record<string, number> = {};
        for (const [type, count] of typeMap) {
          if (count > 0) {
            countsByType[type] = count;
          }
        }
        return { bucket, countsByType };
      });
    return { buckets };
  },
};
