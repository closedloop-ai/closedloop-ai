import { JUDGE_RADAR_METRICS, JUDGE_THRESHOLDS } from "@repo/api/src/constants";
import type { ArtifactType } from "@repo/api/src/types/artifact";
import {
  type EvaluationReportType,
  EvaluationReportType as EvaluationReportTypeValues,
} from "@repo/api/src/types/evaluation";
import {
  type ArtifactCountBucket,
  type ArtifactCountsGroupBy,
  type ArtifactCountsResponse,
  type ArtifactTypeGroup,
  type CharacteristicLabel,
  type JudgeAggregateStats,
  type JudgeDetailResponse,
  type JudgePromptVersion,
  type JudgeScoreRow,
  type JudgeScoresResponse,
  type JudgeStatsResponse,
  PR_TIMELINE_GRANULARITY_OPTIONS,
  type PrHealthResponse,
  type PrTimelineGranularity,
  type RadarAxes,
} from "@repo/api/src/types/judges-analytics";
import { computeMean as computeMeanFromUtils } from "@repo/api/src/utils/math";
import { GitHubPRState, PromptType, withDb } from "@repo/database";
import { log } from "@repo/observability/log";
import { normalizeJudgeName } from "@/lib/judge-name-utils";

/** getUTCDay() returns 0 for Sunday; ISO week starts on Monday. */
const SUNDAY_INDEX = 0;
/** Days from Sunday back to the previous Monday. */
const ISO_WEEK_OFFSET_FROM_SUNDAY = -6;
type HumanCountsByType = {
  humanRatingsByType: Map<ArtifactType, number>;
  humanCommentsByType: Map<ArtifactType, number>;
};

function formatDateKey(year: number, month: number, day: number): string {
  return `${year}-${String(month + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

function bucketKey(
  d: Date,
  groupBy: ArtifactCountsGroupBy | PrTimelineGranularity
): string {
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
}

type PrRow = {
  id: string;
  state: string;
  createdAt: Date;
  mergedAt: Date | null;
  reviewCommentCount: number;
};

type JudgeScoreWithPrs = {
  evaluation: {
    artifact: {
      pullRequests: Array<{
        id: string;
        state: string;
        createdAt: Date;
        mergedAt: Date | null;
        reviewComments: Array<{ id: string }>;
      }>;
    };
  };
};

function flattenJudgeScoresToPrs(judgeScores: JudgeScoreWithPrs[]): PrRow[] {
  const prMap = new Map<string, PrRow>();
  for (const js of judgeScores) {
    for (const pr of js.evaluation.artifact.pullRequests) {
      if (!prMap.has(pr.id)) {
        prMap.set(pr.id, {
          id: pr.id,
          state: pr.state,
          createdAt: pr.createdAt,
          mergedAt: pr.mergedAt,
          reviewCommentCount: pr.reviewComments.length,
        });
      }
    }
  }
  return Array.from(prMap.values());
}

const MS_PER_HOUR = 3_600_000;

function computeAvgApprovalHours(
  mergedPrs: Array<{ mergedAt: Date; createdAt: Date }>
): number | null {
  if (mergedPrs.length === 0) {
    return null;
  }
  const approvalHours = mergedPrs.map(
    (pr) => (pr.mergedAt.getTime() - pr.createdAt.getTime()) / MS_PER_HOUR
  );
  return computeMean(approvalHours);
}

function computeApprovalDistribution(
  mergedPrs: Array<{ mergedAt: Date; createdAt: Date }>
): Record<"lt1d" | "1to3d" | "3to7d" | "gt7d", number> {
  const dist = { lt1d: 0, "1to3d": 0, "3to7d": 0, gt7d: 0 };
  for (const pr of mergedPrs) {
    const hours =
      (pr.mergedAt.getTime() - pr.createdAt.getTime()) / MS_PER_HOUR;
    if (hours < 24) {
      dist.lt1d++;
    } else if (hours < 72) {
      dist["1to3d"]++;
    } else if (hours < 168) {
      dist["3to7d"]++;
    } else {
      dist.gt7d++;
    }
  }
  return dist;
}

function buildPrTimeline(
  prs: PrRow[],
  startDate: Date,
  endDate: Date,
  granularity: PrTimelineGranularity
): Array<{ bucket: string; openedCount: number }> {
  const allBucketKeys = generateBucketRange(startDate, endDate, granularity);
  const timelineCounts = new Map<string, number>();
  for (const key of allBucketKeys) {
    timelineCounts.set(key, 0);
  }
  for (const pr of prs) {
    if (pr.createdAt >= startDate && pr.createdAt <= endDate) {
      const key = bucketKey(pr.createdAt, granularity);
      timelineCounts.set(key, (timelineCounts.get(key) ?? 0) + 1);
    }
  }
  return [...timelineCounts.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([bucket, openedCount]) => ({ bucket, openedCount }));
}

/** Generates all bucket keys between startDate and endDate for the given granularity. */
function generateBucketRange(
  startDate: Date,
  endDate: Date,
  granularity: PrTimelineGranularity
): string[] {
  const keys: string[] = [];
  const current = new Date(startDate);

  if (granularity === PR_TIMELINE_GRANULARITY_OPTIONS.Week) {
    // Align to week start
    const weekStart = getISOWeekStartDate(current);
    current.setUTCFullYear(weekStart.getUTCFullYear());
    current.setUTCMonth(weekStart.getUTCMonth());
    current.setUTCDate(weekStart.getUTCDate());
    while (current <= endDate) {
      keys.push(
        formatDateKey(
          current.getUTCFullYear(),
          current.getUTCMonth(),
          current.getUTCDate()
        )
      );
      current.setUTCDate(current.getUTCDate() + 7);
    }
  } else {
    // Month granularity — align to start of month
    current.setUTCDate(1);
    while (current <= endDate) {
      keys.push(
        formatDateKey(current.getUTCFullYear(), current.getUTCMonth(), 1)
      );
      current.setUTCMonth(current.getUTCMonth() + 1);
    }
  }

  return keys;
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

function initializeHumanCountsByType(types: ArtifactType[]): HumanCountsByType {
  const humanRatingsByType = new Map<ArtifactType, number>();
  const humanCommentsByType = new Map<ArtifactType, number>();

  for (const type of types) {
    humanRatingsByType.set(type, 0);
    humanCommentsByType.set(type, 0);
  }

  return { humanRatingsByType, humanCommentsByType };
}

function incrementHumanCountsByType<TRow>(
  rows: TRow[],
  typeById: Map<string, ArtifactType>,
  humanRatingsByType: Map<ArtifactType, number>,
  humanCommentsByType: Map<ArtifactType, number>,
  getId: (row: TRow) => string,
  getComment: (row: TRow) => string | null | undefined = (row) =>
    (row as { comment?: string | null }).comment
): void {
  for (const row of rows) {
    const type = typeById.get(getId(row));
    if (type === undefined) {
      continue;
    }

    humanRatingsByType.set(type, (humanRatingsByType.get(type) ?? 0) + 1);

    const comment = getComment(row);
    if (comment != null && comment.trim() !== "") {
      humanCommentsByType.set(type, (humanCommentsByType.get(type) ?? 0) + 1);
    }
  }
}

function collectNormalizedScores<TRow>(
  rows: TRow[],
  getKey: (row: TRow) => string | undefined,
  getScore: (row: TRow) => number = (row) => (row as { score: number }).score
): Map<string, number[]> {
  const scoresByKey = new Map<string, number[]>();
  for (const row of rows) {
    const key = getKey(row);
    if (key === undefined) {
      continue;
    }
    const scores = scoresByKey.get(key) ?? [];
    scores.push(getScore(row) / 5);
    scoresByKey.set(key, scores);
  }
  return scoresByKey;
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
): Promise<HumanCountsByType> {
  const { humanRatingsByType, humanCommentsByType } =
    initializeHumanCountsByType(types);

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
        organizationId,
        artifactId: { in: orgArtifactIds },
        createdAt: { gte: startDate, lte: endDate },
      },
      select: { artifactId: true, comment: true },
    })
  );

  incrementHumanCountsByType(
    ratings,
    idToType,
    humanRatingsByType,
    humanCommentsByType,
    (rating) => rating.artifactId
  );

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

  return collectNormalizedScores(ratings, (rating) => rating.artifactId);
}

/**
 * Fetches CODE human ratings/comments counts per artifact type by traversing:
 * Artifact (implementation plan) -> GitHubPullRequest -> PullRequestRating.
 *
 * @internal Exported for unit testing.
 */
export async function getCodeHumanCountsByType(
  organizationId: string,
  startDate: Date,
  endDate: Date,
  types: ArtifactType[]
): Promise<HumanCountsByType> {
  const { humanRatingsByType, humanCommentsByType } =
    initializeHumanCountsByType(types);

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

  if (artifacts.length === 0) {
    return { humanRatingsByType, humanCommentsByType };
  }

  const idToType = new Map(
    artifacts.map((artifact) => [artifact.id, artifact.type] as const)
  );
  const artifactIds = artifacts.map((artifact) => artifact.id);

  const pullRequests = await withDb((db) =>
    db.gitHubPullRequest.findMany({
      where: {
        organizationId,
        artifactId: { in: artifactIds },
      },
      select: { id: true, artifactId: true },
    })
  );

  if (pullRequests.length === 0) {
    return { humanRatingsByType, humanCommentsByType };
  }

  const prIdToType = new Map<string, ArtifactType>();
  for (const pullRequest of pullRequests) {
    if (pullRequest.artifactId == null) {
      continue;
    }
    const type = idToType.get(pullRequest.artifactId);
    if (type !== undefined) {
      prIdToType.set(pullRequest.id, type);
    }
  }

  if (prIdToType.size === 0) {
    return { humanRatingsByType, humanCommentsByType };
  }

  const ratings = await withDb((db) =>
    db.pullRequestRating.findMany({
      where: {
        organizationId,
        pullRequestId: { in: Array.from(prIdToType.keys()) },
        createdAt: { gte: startDate, lte: endDate },
      },
      select: { pullRequestId: true, comment: true },
    })
  );

  incrementHumanCountsByType(
    ratings,
    prIdToType,
    humanRatingsByType,
    humanCommentsByType,
    (rating) => rating.pullRequestId
  );

  return { humanRatingsByType, humanCommentsByType };
}

/**
 * Fetches CODE human ratings and returns normalized scores (0-1) per artifact.
 * Uses pull request ratings linked to the artifact via GitHubPullRequest.artifactId.
 *
 * @internal Exported for unit testing.
 */
export async function getCodeHumanRatingsByArtifact(
  organizationId: string,
  startDate: Date,
  endDate: Date,
  artifactIds: string[]
): Promise<Map<string, number[]>> {
  if (artifactIds.length === 0) {
    return new Map();
  }

  const pullRequests = await withDb((db) =>
    db.gitHubPullRequest.findMany({
      where: {
        organizationId,
        artifactId: { in: artifactIds },
      },
      select: { id: true, artifactId: true },
    })
  );

  if (pullRequests.length === 0) {
    return new Map();
  }

  const prIdToArtifactId = new Map<string, string>();
  for (const pullRequest of pullRequests) {
    if (pullRequest.artifactId != null) {
      prIdToArtifactId.set(pullRequest.id, pullRequest.artifactId);
    }
  }

  const ratings = await withDb((db) =>
    db.pullRequestRating.findMany({
      where: {
        organizationId,
        pullRequestId: { in: Array.from(prIdToArtifactId.keys()) },
        createdAt: { gte: startDate, lte: endDate },
      },
      select: { pullRequestId: true, score: true },
    })
  );

  return collectNormalizedScores(ratings, (rating) =>
    prIdToArtifactId.get(rating.pullRequestId)
  );
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
  humanRatingsByArtifact: Map<string, number[]>,
  judgeDescriptionByPromptName: Map<string, string>
): JudgeAggregateStats | null {
  const scores = judgeData.scores;
  const count = scores.length;

  if (count === 0) {
    return null;
  }

  const min = Math.min(...scores);
  const max = Math.max(...scores);
  const mean = computeMean(scores);
  const stdDev = computeStdDev(scores, mean);

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
    description:
      judgeDescriptionByPromptName.get(normalizeJudgeName(judgeName)) ?? null,
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
  const humanMean = computeMean(scores);
  const humanStdDev = computeStdDev(scores, humanMean);

  return { humanMin, humanMax, humanMean, humanStdDev };
}

async function getPlanHumanData(
  organizationId: string,
  startDate: Date,
  endDate: Date,
  types: ArtifactType[],
  artifactIds: string[]
): Promise<{
  humanRatingsByType: Map<ArtifactType, number>;
  humanCommentsByType: Map<ArtifactType, number>;
  humanRatingsByArtifact: Map<string, number[]>;
}> {
  const { humanRatingsByType, humanCommentsByType } =
    await getHumanCountsByType(organizationId, startDate, endDate, types);
  const humanRatingsByArtifact = await getHumanRatingsByArtifact(
    organizationId,
    startDate,
    endDate,
    artifactIds
  );
  return { humanRatingsByType, humanCommentsByType, humanRatingsByArtifact };
}

async function getCodeHumanData(
  organizationId: string,
  startDate: Date,
  endDate: Date,
  types: ArtifactType[],
  artifactIds: string[]
): Promise<{
  humanRatingsByType: Map<ArtifactType, number>;
  humanCommentsByType: Map<ArtifactType, number>;
  humanRatingsByArtifact: Map<string, number[]>;
}> {
  const { humanRatingsByType, humanCommentsByType } =
    await getCodeHumanCountsByType(organizationId, startDate, endDate, types);
  const humanRatingsByArtifact = await getCodeHumanRatingsByArtifact(
    organizationId,
    startDate,
    endDate,
    artifactIds
  );
  return { humanRatingsByType, humanCommentsByType, humanRatingsByArtifact };
}

/** Resolved judge prompts for a given promptName. null when no match. */
type ResolvedJudgePrompts = {
  promptIds: string[];
  matchingPrompts: Array<{
    id: string;
    name: string;
    version: number;
    content: string;
    createdAt: Date;
  }>;
};

async function resolveJudgePromptIds(
  organizationId: string,
  promptName: string
): Promise<ResolvedJudgePrompts | null> {
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

  const matchingPrompts = allJudgePrompts.filter(
    (p) => normalizeJudgeName(p.name) === promptName
  );

  if (matchingPrompts.length === 0) {
    return null;
  }

  return {
    promptIds: matchingPrompts.map((p) => p.id),
    matchingPrompts,
  };
}

async function getJudgeDescriptionByPromptName(
  organizationId: string
): Promise<Map<string, string>> {
  const judgePrompts = await withDb((db) =>
    db.prompt.findMany({
      where: {
        organizationId,
        promptType: PromptType.JUDGE,
      },
      select: {
        name: true,
        description: true,
        version: true,
      },
      orderBy: [{ version: "desc" }, { name: "asc" }],
    })
  );

  const latestPromptByName = new Map<
    string,
    { version: number; description: string }
  >();
  for (const prompt of judgePrompts) {
    const promptName = normalizeJudgeName(prompt.name);
    const existing = latestPromptByName.get(promptName);
    if (existing === undefined || prompt.version > existing.version) {
      latestPromptByName.set(promptName, {
        version: prompt.version,
        description: prompt.description,
      });
    }
  }

  const promptDescriptions = new Map<string, string>();
  for (const [promptName, latestPrompt] of latestPromptByName) {
    promptDescriptions.set(promptName, latestPrompt.description);
  }

  return promptDescriptions;
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
    endDate: Date,
    reportType: EvaluationReportType
  ): Promise<JudgeStatsResponse> {
    const judgeDescriptionByPromptName =
      await getJudgeDescriptionByPromptName(organizationId);

    // Query JudgeScore rows joined through ArtifactEvaluation → Artifact
    const judgeScores = await withDb((db) =>
      db.judgeScore.findMany({
        where: {
          evaluation: {
            reportType,
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
        reportType,
      });
    }

    // Aggregate scores by artifact type and judge name (caseId)
    const aggregator = aggregateJudgeScoreRows(judgeScores);

    const types = Array.from(aggregator.keys());
    const artifactIds = collectAllArtifactIds(aggregator);

    const { humanRatingsByType, humanCommentsByType, humanRatingsByArtifact } =
      reportType === EvaluationReportTypeValues.Code
        ? await getCodeHumanData(
            organizationId,
            startDate,
            endDate,
            types,
            artifactIds
          )
        : await getPlanHumanData(
            organizationId,
            startDate,
            endDate,
            types,
            artifactIds
          );

    // Compute statistics for each judge within each artifact type
    const groups: ArtifactTypeGroup[] = [];

    for (const [artifactType, judgeMap] of aggregator) {
      const judges: JudgeAggregateStats[] = [];

      for (const [judgeName, judgeData] of judgeMap) {
        const stats = computeJudgeStats(
          judgeName,
          judgeData,
          humanRatingsByArtifact,
          judgeDescriptionByPromptName
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

    return { reportType, groups };
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

    const bucketTypeCounts = new Map<string, Map<string, number>>();
    for (const { createdAt, type } of artifacts) {
      const key = bucketKey(createdAt, groupBy);
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
    promptName: string,
    reportType: EvaluationReportType
  ): Promise<JudgeDetailResponse | null> {
    const resolved = await resolveJudgePromptIds(organizationId, promptName);
    if (resolved === null) {
      return null;
    }

    const { promptIds, matchingPrompts } = resolved;
    const latestPrompt = matchingPrompts[0];
    const promptIdSet = new Set(promptIds);

    // 3. Load score rows — match by promptId (relational) scoped to org
    const allScores = await withDb((db) =>
      db.judgeScore.findMany({
        where: {
          promptId: { in: promptIds },
          evaluation: {
            reportType,
            artifact: { organizationId },
          },
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

      radarAxes = toRadarAxes(stdDev, mean, bimodality, certaintyFraction);

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
        versionRadarAxes = toRadarAxes(
          vStdDev,
          vMean,
          vBimodality,
          vCertaintyFraction
        );
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
        reportType,
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

  /**
   * Get paginated judge scores for a single judge, with human rating comparison.
   *
   * For each artifact scored by this judge, computes avg human rating and delta.
   * Concurrence default: when no human ratings exist, avgUserRating = judgeScore, delta = 0.
   * Sorted by delta DESC then judgeScore DESC (unrated rows last).
   */
  async getJudgeScores(
    organizationId: string,
    promptName: string,
    reportType: EvaluationReportType,
    page: number,
    pageSize: number
  ): Promise<JudgeScoresResponse | null> {
    const resolved = await resolveJudgePromptIds(organizationId, promptName);
    if (resolved === null) {
      return null;
    }

    const { promptIds } = resolved;

    // Load judge scores by promptId (relational), scoped to org and reportType
    const judgeScores = await withDb((db) =>
      db.judgeScore.findMany({
        where: {
          promptId: { in: promptIds },
          evaluation: {
            reportType,
            artifact: { organizationId },
          },
        },
        select: {
          id: true,
          score: true,
          createdAt: true,
          evaluation: {
            select: {
              artifactId: true,
              artifact: {
                select: { id: true, type: true, title: true, slug: true },
              },
            },
          },
          judgeHumanScores: {
            select: { score: true },
          },
        },
        // TODO: Move sorting and pagination into SQL once score ordering is DB-backed.
      })
    );

    if (judgeScores.length === 0) {
      return {
        rows: [],
        totalArtifacts: 0,
        ratedArtifacts: 0,
        coveragePct: 0,
        pagination: { page, pageSize, totalRows: 0, totalPages: 0 },
      };
    }

    // 3. Build rows with concurrence default
    const rows: JudgeScoreRow[] = judgeScores.map((js) => {
      const humanScores = js.judgeHumanScores.map((hs) => hs.score);
      const userRatingCount = humanScores.length;
      const avgUserRating =
        userRatingCount > 0 ? computeMean(humanScores) : js.score;
      const delta =
        userRatingCount > 0 ? Math.abs(avgUserRating - js.score) : 0;

      return {
        judgeScoreId: js.id,
        artifactId: js.evaluation.artifact.id,
        artifactType: js.evaluation.artifact.type,
        artifactTitle: js.evaluation.artifact.title,
        artifactSlug: js.evaluation.artifact.slug,
        judgeScore: js.score,
        avgUserRating,
        userRatingCount,
        delta,
        evaluatedAt: js.createdAt.toISOString(),
      };
    });

    // 4. Sort: delta DESC, then judgeScore DESC (delta=0 rows last)
    rows.sort((a, b) => {
      if (a.delta !== b.delta) {
        return b.delta - a.delta;
      }
      return b.judgeScore - a.judgeScore;
    });

    // 5. Summary counts
    const totalArtifacts = rows.length;
    const ratedArtifacts = rows.filter((r) => r.userRatingCount > 0).length;
    const coveragePct =
      totalArtifacts > 0 ? (ratedArtifacts / totalArtifacts) * 100 : 0;

    // 6. Paginate
    const totalRows = rows.length;
    const totalPages = Math.ceil(totalRows / pageSize);
    const start = (page - 1) * pageSize;
    const paginatedRows = rows.slice(start, start + pageSize);

    return {
      rows: paginatedRows,
      totalArtifacts,
      ratedArtifacts,
      coveragePct,
      pagination: { page, pageSize, totalRows, totalPages },
    };
  },

  /**
   * Get aggregate PR health metrics for a judge (prompt), filtered by report type and date range.
   *
   * Privacy invariant: response contains only aggregate numeric data — never body, authorLogin,
   * or authorAvatarUrl fields from GitHubPRReviewComment.
   *
   * @param organizationId - Organization ID to scope the query
   * @param promptName - URL-safe normalized judge name
   * @param reportType - Evaluation report type filter
   * @param startDate - Start date (inclusive)
   * @param endDate - End date (inclusive)
   * @param granularity - Timeline bucket: "week" or "month"
   * @returns PrHealthResponse with aggregate metrics or null when no matching judge found
   */
  async getPrHealthMetrics(
    organizationId: string,
    promptName: string,
    reportType: EvaluationReportType,
    startDate: Date,
    endDate: Date,
    granularity: PrTimelineGranularity
  ): Promise<PrHealthResponse | null> {
    const resolved = await resolveJudgePromptIds(organizationId, promptName);
    if (resolved === null) {
      return null;
    }

    const judgeScores = await withDb((db) =>
      db.judgeScore.findMany({
        where: {
          promptId: { in: resolved.promptIds },
          evaluation: {
            reportType,
            artifact: { organizationId },
            createdAt: { gte: startDate, lte: endDate },
          },
        },
        select: {
          evaluation: {
            select: {
              artifact: {
                select: {
                  pullRequests: {
                    select: {
                      id: true,
                      state: true,
                      createdAt: true,
                      mergedAt: true,
                      reviewComments: { select: { id: true } },
                    },
                  },
                },
              },
            },
          },
        },
      })
    );

    const prs = flattenJudgeScoresToPrs(judgeScores).filter(
      (pr) => pr.createdAt >= startDate && pr.createdAt <= endDate
    );
    const totalPrs = prs.length;
    const openPrs = prs.filter((pr) => pr.state === GitHubPRState.OPEN).length;
    const totalCommentCount = prs.reduce(
      (acc, pr) => acc + pr.reviewCommentCount,
      0
    );
    const avgCommentCount =
      totalPrs > 0 ? computeMean(prs.map((pr) => pr.reviewCommentCount)) : 0;

    const mergedPrs = prs.filter(
      (pr): pr is PrRow & { mergedAt: Date } =>
        pr.mergedAt != null && pr.state === GitHubPRState.MERGED
    );
    const avgApprovalHours = computeAvgApprovalHours(mergedPrs);
    const approvalDistribution = computeApprovalDistribution(mergedPrs);
    const timeline = buildPrTimeline(prs, startDate, endDate, granularity);

    return {
      totalPrs,
      openPrs,
      avgCommentCount,
      totalCommentCount,
      avgApprovalHours,
      approvalDistribution,
      timeline,
      confidenceNote: `Based on ${totalPrs} PRs`,
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
  return computeMeanFromUtils(values);
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
  const extremeCount = values.filter(
    (v) =>
      v > JUDGE_RADAR_METRICS.certainty.extremeHighScore ||
      v < JUDGE_RADAR_METRICS.certainty.extremeLowScore
  ).length;
  return extremeCount / values.length;
}

function toRadarAxes(
  stdDev: number,
  mean: number,
  bimodality: number,
  certaintyFraction: number
): RadarAxes {
  return {
    stubbornness:
      1 -
      clamp(
        stdDev / JUDGE_RADAR_METRICS.stubbornness.stdDevNormalizationDivisor,
        0,
        1
      ),
    optimism: mean,
    polarity: bimodality,
    certainty: certaintyFraction,
  };
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
