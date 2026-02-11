import type { ArtifactSubtype } from "@repo/api/src/types/artifact";
import type { CaseScore, JudgesReport } from "@repo/api/src/types/evaluation";
import type {
  ArtifactSubtypeGroup,
  JudgeAggregateStats,
  JudgeStatsResponse,
} from "@repo/api/src/types/judges-analytics";
import { withDb } from "@repo/database";

/**
 * Extracts judge scores from evaluation reportData and aggregates them by artifact subtype and judge name.
 *
 * @param evaluations - Array of artifact evaluations with their artifact subtype
 * @returns Nested map structure: artifactSubtype -> judgeName -> { scores, artifactIds }
 */
function extractJudgeScores(
  evaluations: Array<{
    artifactId: string;
    artifact: { subtype: string };
    reportData: unknown;
  }>
): Map<string, Map<string, { scores: number[]; artifactIds: Set<string> }>> {
  const aggregator = new Map<
    string,
    Map<string, { scores: number[]; artifactIds: Set<string> }>
  >();

  for (const evaluation of evaluations) {
    const artifactSubtype = evaluation.artifact.subtype;
    const reportData = evaluation.reportData as JudgesReport;

    if (!(reportData?.stats && Array.isArray(reportData.stats))) {
      continue;
    }

    for (const caseScore of reportData.stats as CaseScore[]) {
      const judgeName = caseScore.case_id;

      // Find the MetricStatistics entry where metric_name matches case_id (judge name)
      const judgeMetric = caseScore.metrics?.find(
        (metric) => metric.metric_name === caseScore.case_id
      );

      if (!judgeMetric) {
        continue;
      }

      // Initialize nested maps if needed
      if (!aggregator.has(artifactSubtype)) {
        aggregator.set(artifactSubtype, new Map());
      }

      const judgeMap = aggregator.get(artifactSubtype)!;

      if (!judgeMap.has(judgeName)) {
        judgeMap.set(judgeName, {
          scores: [],
          artifactIds: new Set(),
        });
      }

      const judgeData = judgeMap.get(judgeName)!;
      judgeData.scores.push(judgeMetric.score);
      judgeData.artifactIds.add(evaluation.artifactId);
    }
  }

  return aggregator;
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
        include: {
          artifact: {
            select: {
              subtype: true,
            },
          },
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
        artifactSubtype: artifactSubtype as ArtifactSubtype,
        judges,
      });
    }

    return { groups };
  },
};
