import { JUDGE_THRESHOLDS } from "@repo/api/src/constants";
import type { ArtifactType } from "@repo/api/src/types/artifact";
import type {
  ArtifactCountBucket,
  ArtifactCountsGroupBy,
  ArtifactCountsResponse,
  ArtifactTypeGroup,
  CharacteristicLabel,
  JudgeAggregateStats,
  JudgeDetailResponse,
  JudgePromptVersion,
  JudgeStatsResponse,
  RadarAxes,
} from "@repo/api/src/types/judges-analytics";
import { PromptType, withDb } from "@repo/database";
import { log } from "@repo/observability/log";
import { normalizeJudgeName } from "@/lib/judge-name-utils";

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

  if (types.length === 0) {
    return { humanRatingsByType, humanCommentsByType };
  }

  for (const type of types) {
    humanRatingsByType.set(type, 0);
    humanCommentsByType.set(type, 0);
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
        organizationId,
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
 * Fetches human ratings and returns all normalized scores (0-1) per artifact.
 * Each score is raw_score / 5. Multiple ratings per artifact are preserved as an array.
 *
 * @internal Exported for unit testing.
 */
export async function getHumanRatingsByArtifact(
  organizationId: string,
  startDate: Date,
  endDate: Date,
  artifactIds: string[]
): Promise<Map<string, number[]>> {
  if (artifactIds.length === 0) {
    return new Map();
  }

  const ratings = await withDb((db) =>
    db.artifactRating.findMany({
      where: {
        organizationId,
        artifactId: { in: artifactIds },
        createdAt: { gte: startDate, lte: endDate },
      },
      select: { artifactId: true, score: true },
    })
  );

  const scoresByArtifact = new Map<string, number[]>();
  for (const r of ratings) {
    const scores = scoresByArtifact.get(r.artifactId) ?? [];
    scores.push(r.score / 5);
    scoresByArtifact.set(r.artifactId, scores);
  }

  return scoresByArtifact;
}

/** Shape of a JudgeScore row with evaluation and artifact relations for aggregation. */
export type JudgeScoreInput = {
  caseId: string;
  score: number;
  evaluation: {
    artifactId: string;
    artifact: { type: ArtifactType };
  };
};

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

/**
 * Aggregates JudgeScore rows into a nested map keyed by artifact type and judge name.
 *
 * @param judgeScores - Array of JudgeScore rows with evaluation and artifact relations
 * @returns Nested map structure: artifactType -> caseId -> { scores, artifactIds }
 */
export function aggregateJudgeScoreRows(
  judgeScores: JudgeScoreInput[]
): Map<
  ArtifactType,
  Map<string, { scores: number[]; artifactIds: Set<string> }>
> {
  const aggregator = new JudgeScoreAggregator();

  for (const row of judgeScores) {
    aggregator.addScore(
      row.evaluation.artifact.type,
      row.caseId,
      row.score,
      row.evaluation.artifactId
    );
  }

  return aggregator.getResults();
}

/** Collects all unique artifact IDs from the aggregator across all types and judges. */
function collectAllArtifactIds(
  aggregator: Map<
    ArtifactType,
    Map<string, { scores: number[]; artifactIds: Set<string> }>
  >
): string[] {
  const allIds = new Set<string>();
  for (const judgeMap of aggregator.values()) {
    for (const judgeData of judgeMap.values()) {
      for (const id of judgeData.artifactIds) {
        allIds.add(id);
      }
    }
  }
  return Array.from(allIds);
}

/** Computes aggregate stats for a single judge given its scores and human ratings lookup. */
function computeJudgeStats(
  judgeName: string,
  judgeData: { scores: number[]; artifactIds: Set<string> },
  humanRatingsByArtifact: Map<string, number[]>
): JudgeAggregateStats | null {
  const scores = judgeData.scores;
  const count = scores.length;

  if (count === 0) {
    return null;
  }

  const min = Math.min(...scores);
  const max = Math.max(...scores);
  const sum = scores.reduce((acc, score) => acc + score, 0);
  const mean = sum / count;

  const variance =
    scores.reduce((acc, score) => acc + (score - mean) ** 2, 0) / count;
  const stdDev = Math.sqrt(variance);

  // Pool all human scores across this judge's artifacts
  const judgeHumanScores: number[] = [];
  for (const artifactId of judgeData.artifactIds) {
    const artifactScores = humanRatingsByArtifact.get(artifactId);
    if (artifactScores) {
      judgeHumanScores.push(...artifactScores);
    }
  }

  return {
    judgeName,
    promptName: normalizeJudgeName(judgeName),
    artifactsEvaluated: judgeData.artifactIds.size,
    min,
    mean,
    max,
    stdDev,
    ...computeHumanStats(judgeHumanScores),
  };
}

/** Computes human rating stats from pooled normalized scores. Returns all-null when no scores. */
function computeHumanStats(scores: number[]): {
  humanMin: number | null;
  humanMax: number | null;
  humanMean: number | null;
  humanStdDev: number | null;
} {
  if (scores.length === 0) {
    return {
      humanMin: null,
      humanMax: null,
      humanMean: null,
      humanStdDev: null,
    };
  }

  const humanMin = Math.min(...scores);
  const humanMax = Math.max(...scores);
  const humanSum = scores.reduce((acc, s) => acc + s, 0);
  const humanMean = humanSum / scores.length;
  const humanVariance =
    scores.reduce((acc, s) => acc + (s - humanMean) ** 2, 0) / scores.length;
  const humanStdDev = Math.sqrt(humanVariance);

  return { humanMin, humanMax, humanMean, humanStdDev };
}

/**
 * Aggregation service for judges analytics.
 *
 * Queries JudgeScore rows within a date range and computes aggregate statistics
 * (min, mean, max, stdDev) grouped by artifact type and judge name (caseId).
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
    // Query JudgeScore rows joined through ArtifactEvaluation → Artifact
    const judgeScores = await withDb((db) =>
      db.judgeScore.findMany({
        where: {
          evaluation: {
            artifact: { organizationId },
            createdAt: { gte: startDate, lte: endDate },
          },
        },
        select: {
          caseId: true,
          score: true,
          evaluation: {
            select: {
              artifactId: true,
              artifact: { select: { type: true } },
            },
          },
        },
      })
    );

    if (judgeScores.length === 0) {
      log.warn("No judge scores found for judges analytics query", {
        organizationId,
        startDate: startDate.toISOString(),
        endDate: endDate.toISOString(),
      });
    }

    // Aggregate scores by artifact type and judge name (caseId)
    const aggregator = aggregateJudgeScoreRows(judgeScores);

    const types = Array.from(aggregator.keys());
    const { humanRatingsByType, humanCommentsByType } =
      await getHumanCountsByType(organizationId, startDate, endDate, types);

    // Fetch per-artifact human ratings (all normalized 0-1 scores)
    const humanRatingsByArtifact = await getHumanRatingsByArtifact(
      organizationId,
      startDate,
      endDate,
      collectAllArtifactIds(aggregator)
    );

    // Compute statistics for each judge within each artifact type
    const groups: ArtifactTypeGroup[] = [];

    for (const [artifactType, judgeMap] of aggregator) {
      const judges: JudgeAggregateStats[] = [];

      for (const [judgeName, judgeData] of judgeMap) {
        const stats = computeJudgeStats(
          judgeName,
          judgeData,
          humanRatingsByArtifact
        );
        if (stats) {
          judges.push(stats);
        }
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

  /**
   * Get detailed statistics for a single judge identified by normalized prompt name.
   *
   * @param organizationId - Organization ID to scope the query
   * @param promptName - URL-safe normalized judge name (e.g. "clarity")
   * @returns Full judge detail or null if not found
   */
  async getJudgeDetail(
    organizationId: string,
    promptName: string
  ): Promise<JudgeDetailResponse | null> {
    // 1. Resolve judge by promptName — find all JUDGE prompts in org and match normalized name
    const allJudgePrompts = await withDb((db) =>
      db.prompt.findMany({
        where: {
          organizationId,
          promptType: PromptType.JUDGE,
        },
        select: {
          id: true,
          name: true,
          version: true,
          content: true,
          createdAt: true,
        },
        orderBy: { version: "desc" },
      })
    );

    // Group prompts by normalized name
    const matchingPrompts = allJudgePrompts.filter(
      (p) => normalizeJudgeName(p.name) === promptName
    );

    if (matchingPrompts.length === 0) {
      return null;
    }

    // 2. Latest prompt is first (ordered by version DESC)
    const latestPrompt = matchingPrompts[0];

    // Collect all raw names for this judge (different versions may have slightly different raw names)
    const rawNames = new Set(matchingPrompts.map((p) => p.name));
    const promptIds = matchingPrompts.map((p) => p.id);
    const promptIdSet = new Set(promptIds);

    // Expand to include hyphen/underscore variants so we match stored caseIds
    const caseIdVariants = new Set<string>();
    for (const name of rawNames) {
      caseIdVariants.add(name);
      caseIdVariants.add(name.replaceAll("_", "-"));
      caseIdVariants.add(name.replaceAll("-", "_"));
    }

    // 3. Load score rows — match by caseId (any raw name variant) scoped to org
    const allScores = await withDb((db) =>
      db.judgeScore.findMany({
        where: {
          evaluation: {
            artifact: { organizationId },
          },
          caseId: { in: Array.from(caseIdVariants) },
        },
        select: {
          promptId: true,
          score: true,
          threshold: true,
          finalStatus: true,
          createdAt: true,
        },
      })
    );

    const scoreValues = allScores.map((s) => s.score);
    const scoreCount = scoreValues.length;

    // 4. Compute radar axes (null when insufficient scores)
    let radarAxes: RadarAxes | null = null;
    let labels: CharacteristicLabel[] = [];

    if (scoreCount >= JUDGE_THRESHOLDS.minScoreCount) {
      const mean = computeMean(scoreValues);
      const stdDev = computeStdDev(scoreValues, mean);
      const bimodality = computeBimodalityCoefficient(scoreValues);
      const certaintyFraction = computeCertaintyFraction(scoreValues);

      radarAxes = {
        stubbornness: 1 - clamp(stdDev / 0.5, 0, 1),
        optimism: mean,
        polarity: bimodality,
        certainty: certaintyFraction,
      };

      // 5. Derive characteristic labels from raw stats
      labels = deriveCharacteristicLabels(
        stdDev,
        mean,
        bimodality,
        certaintyFraction
      );
    }

    // 6. Build per-version stats
    const scoresByPromptId = new Map<string, number[]>();
    let unknownVersionScoreCount = 0;

    for (const s of allScores) {
      if (s.promptId && promptIdSet.has(s.promptId)) {
        const bucket = scoresByPromptId.get(s.promptId) ?? [];
        bucket.push(s.score);
        scoresByPromptId.set(s.promptId, bucket);
      } else {
        unknownVersionScoreCount++;
      }
    }

    const promptVersions: JudgePromptVersion[] = [];
    for (const prompt of matchingPrompts) {
      const versionScores = scoresByPromptId.get(prompt.id);
      if (!versionScores || versionScores.length === 0) {
        continue;
      }

      const vMean = computeMean(versionScores);
      const vStdDev = computeStdDev(versionScores, vMean);

      let versionRadarAxes: RadarAxes | null = null;
      if (versionScores.length >= JUDGE_THRESHOLDS.minScoreCount) {
        const vBimodality = computeBimodalityCoefficient(versionScores);
        const vCertaintyFraction = computeCertaintyFraction(versionScores);
        versionRadarAxes = {
          stubbornness: 1 - clamp(vStdDev / 0.5, 0, 1),
          optimism: vMean,
          polarity: vBimodality,
          certainty: vCertaintyFraction,
        };
      }

      promptVersions.push({
        promptId: prompt.id,
        version: prompt.version,
        scoreCount: versionScores.length,
        mean: vMean,
        stdDev: vStdDev,
        min: Math.min(...versionScores),
        max: Math.max(...versionScores),
        createdAt: prompt.createdAt.toISOString(),
        radarAxes: versionRadarAxes,
      });
    }

    return {
      judge: {
        promptName,
        displayName: latestPrompt.name,
        latestPromptId: latestPrompt.id,
        scoreCount,
        radarAxes,
        labels,
        promptText: latestPrompt.content,
        promptVersions,
        unknownVersionScoreCount,
      },
    };
  },
};

// ---------------------------------------------------------------------------
// Statistical helper functions
// ---------------------------------------------------------------------------

export function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

export function computeMean(values: number[]): number {
  if (values.length === 0) {
    return 0;
  }
  return values.reduce((acc, v) => acc + v, 0) / values.length;
}

export function computeStdDev(values: number[], mean: number): number {
  if (values.length === 0) {
    return 0;
  }
  const variance =
    values.reduce((acc, v) => acc + (v - mean) ** 2, 0) / values.length;
  return Math.sqrt(variance);
}

export function computeSkewness(
  values: number[],
  mean: number,
  stdDev: number
): number {
  const n = values.length;
  if (n < 3 || stdDev === 0) {
    return 0;
  }
  const m3 = values.reduce((acc, v) => acc + ((v - mean) / stdDev) ** 3, 0) / n;
  return m3;
}

export function computeExcessKurtosis(
  values: number[],
  mean: number,
  stdDev: number
): number {
  const n = values.length;
  if (n < 4 || stdDev === 0) {
    return 0;
  }
  const m4 = values.reduce((acc, v) => acc + ((v - mean) / stdDev) ** 4, 0) / n;
  return m4 - 3;
}

export function computeBimodalityCoefficient(values: number[]): number {
  const n = values.length;
  if (n < 4) {
    return 0;
  }

  const mean = computeMean(values);
  const stdDev = computeStdDev(values, mean);
  if (stdDev === 0) {
    return 0;
  }

  const skewness = computeSkewness(values, mean, stdDev);
  const excessKurtosis = computeExcessKurtosis(values, mean, stdDev);

  const denominator = excessKurtosis + (3 * (n - 1) ** 2) / ((n - 2) * (n - 3));
  if (denominator <= 0) {
    return 0;
  }

  const bc = (skewness ** 2 + 1) / denominator;
  return clamp(bc, 0, 1);
}

export function computeCertaintyFraction(values: number[]): number {
  if (values.length === 0) {
    return 0;
  }
  const extremeCount = values.filter((v) => v > 0.7 || v < 0.3).length;
  return extremeCount / values.length;
}

export function deriveCharacteristicLabels(
  stdDev: number,
  mean: number,
  bimodality: number,
  certaintyFraction: number
): CharacteristicLabel[] {
  const labels: CharacteristicLabel[] = [];

  if (stdDev < JUDGE_THRESHOLDS.stubbornness.stubborn) {
    labels.push("Stubborn");
  } else if (stdDev > JUDGE_THRESHOLDS.stubbornness.openMinded) {
    labels.push("Open-Minded");
  }

  if (mean > JUDGE_THRESHOLDS.optimism.optimistic) {
    labels.push("Optimistic");
  } else if (mean < JUDGE_THRESHOLDS.optimism.critical) {
    labels.push("Critical");
  }

  if (bimodality > JUDGE_THRESHOLDS.polarity.polarizing) {
    labels.push("Polarizing");
  }

  if (certaintyFraction > JUDGE_THRESHOLDS.certainty.decisive) {
    labels.push("Decisive");
  } else if (certaintyFraction < JUDGE_THRESHOLDS.certainty.uncertain) {
    labels.push("Uncertain");
  }

  return labels;
}
