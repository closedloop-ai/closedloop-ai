import { JUDGE_RADAR_METRICS, JUDGE_THRESHOLDS } from "@repo/api/src/constants";
import { LinkType } from "@repo/api/src/types/artifact";
import type { DocumentType } from "@repo/api/src/types/document";
import {
  type EvaluationReportType,
  EvaluationReportType as EvaluationReportTypeValues,
} from "@repo/api/src/types/evaluation";
import type {
  CharacteristicLabel,
  DocumentCountBucket,
  DocumentCountsGroupBy,
  DocumentCountsResponse,
  DocumentTypeGroup,
  JudgeAggregateStats,
  JudgeDetailResponse,
  JudgePromptVersion,
  JudgeScoreRow,
  JudgeScoresResponse,
  JudgeStatsResponse,
  RadarAxes,
} from "@repo/api/src/types/judges-analytics";
import {
  clamp,
  computeMean as computeMeanFromUtils,
} from "@repo/api/src/utils/math";
import { ArtifactType, Prisma, PromptType, withDb } from "@repo/database";
import { log } from "@repo/observability/log";
import { normalizeJudgeName } from "@/lib/judge-name-utils";
import { toNumber } from "@/lib/prisma-number";

type HumanCountsByType = {
  humanRatingsByType: Map<DocumentType, number>;
  humanCommentsByType: Map<DocumentType, number>;
};

function initializeHumanCountsByType(types: DocumentType[]): HumanCountsByType {
  const humanRatingsByType = new Map<DocumentType, number>();
  const humanCommentsByType = new Map<DocumentType, number>();

  for (const type of types) {
    humanRatingsByType.set(type, 0);
    humanCommentsByType.set(type, 0);
  }

  return { humanRatingsByType, humanCommentsByType };
}

function incrementHumanCountsByType<TRow>(
  rows: TRow[],
  typeById: Map<string, DocumentType>,
  humanRatingsByType: Map<DocumentType, number>,
  humanCommentsByType: Map<DocumentType, number>,
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
  types: DocumentType[]
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
        type: ArtifactType.DOCUMENT,
        subtype: { in: types },
      },
      select: { id: true, subtype: true },
    })
  );

  const idToType = new Map<string, DocumentType>(
    artifacts.flatMap((a) =>
      a.subtype === null ? [] : [[a.id, a.subtype as DocumentType] as const]
    )
  );
  const orgArtifactIds = Array.from(idToType.keys());

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
  types: DocumentType[]
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
        type: ArtifactType.DOCUMENT,
        subtype: { in: types },
      },
      select: { id: true, subtype: true },
    })
  );

  if (artifacts.length === 0) {
    return { humanRatingsByType, humanCommentsByType };
  }

  const idToType = new Map<string, DocumentType>(
    artifacts.flatMap((a) =>
      a.subtype === null ? [] : [[a.id, a.subtype as DocumentType] as const]
    )
  );
  const artifactIds = Array.from(idToType.keys());

  // Branch artifacts that were produced by these document artifacts are linked
  // via ArtifactLink (source = plan, target = branch, linkType = PRODUCES).
  const prLinks = await withDb((db) =>
    db.artifactLink.findMany({
      where: {
        organizationId,
        sourceId: { in: artifactIds },
        linkType: LinkType.Produces,
        target: { type: ArtifactType.BRANCH },
      },
      select: { sourceId: true, targetId: true },
    })
  );

  if (prLinks.length === 0) {
    return { humanRatingsByType, humanCommentsByType };
  }

  const prIdToType = new Map<string, DocumentType>();
  for (const link of prLinks) {
    const type = idToType.get(link.sourceId);
    if (type !== undefined) {
      prIdToType.set(link.targetId, type);
    }
  }

  if (prIdToType.size === 0) {
    return { humanRatingsByType, humanCommentsByType };
  }

  const ratings = await withDb((db) =>
    db.artifactRating.findMany({
      where: {
        organizationId,
        artifactId: { in: Array.from(prIdToType.keys()) },
        createdAt: { gte: startDate, lte: endDate },
      },
      select: { artifactId: true, comment: true },
    })
  );

  incrementHumanCountsByType(
    ratings,
    prIdToType,
    humanRatingsByType,
    humanCommentsByType,
    (rating) => rating.artifactId
  );

  return { humanRatingsByType, humanCommentsByType };
}

/**
 * Fetches CODE human ratings and returns normalized scores (0-1) per artifact.
 * Uses branch artifact ratings linked to the source document artifact.
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

  const prLinks = await withDb((db) =>
    db.artifactLink.findMany({
      where: {
        organizationId,
        sourceId: { in: artifactIds },
        linkType: LinkType.Produces,
        target: { type: ArtifactType.BRANCH },
      },
      select: { sourceId: true, targetId: true },
    })
  );

  if (prLinks.length === 0) {
    return new Map();
  }

  const prIdToArtifactId = new Map<string, string>();
  for (const link of prLinks) {
    prIdToArtifactId.set(link.targetId, link.sourceId);
  }

  const ratings = await withDb((db) =>
    db.artifactRating.findMany({
      where: {
        organizationId,
        artifactId: { in: Array.from(prIdToArtifactId.keys()) },
        createdAt: { gte: startDate, lte: endDate },
      },
      select: { artifactId: true, score: true },
    })
  );

  return collectNormalizedScores(ratings, (rating) =>
    prIdToArtifactId.get(rating.artifactId)
  );
}

/** Shape of a JudgeScore row with evaluation and artifact relations for aggregation. */
export type JudgeScoreInput = {
  caseId: string;
  metricName: string;
  promptId: string | null;
  score: number;
  evaluation: {
    documentId: string | null;
    entityId: string;
    documentType: DocumentType;
  };
};

/**
 * A DB-side pre-aggregation of judge scores over one
 * `(documentType, metricName, promptId, caseId)` partition. Emitted by the
 * grouped `getAggregateStats` query so the app folds a bounded number of groups
 * instead of the full per-score population. Carries power sums plus the distinct
 * artifact ids in the group (needed for human-rating pooling / documentsEvaluated).
 */
export type JudgeScoreGroup = {
  caseId: string;
  metricName: string;
  promptId: string | null;
  documentType: DocumentType;
  count: number;
  sum: number;
  sumSq: number;
  min: number;
  max: number;
  documentIds: string[];
};

/**
 * Aggregates judge scores by document type and judge name.
 *
 * Alongside the raw `scores` array (retained for the pure-function contract of
 * {@link aggregateJudgeScoreRows}), the accumulator carries power sums
 * (count/sum/sumSq/min/max). The power sums are what {@link computeJudgeStats}
 * reads, so a caller can fold in *pre-aggregated* DB groups (via `addGroup`)
 * without ever materializing the full judge-score population in app memory.
 */
type AggregatedJudgeData = {
  /** Raw scores — populated only by the per-score `addScore` path. */
  scores: number[];
  count: number;
  sum: number;
  sumSq: number;
  min: number;
  max: number;
  documentIds: Set<string>;
  promptName: string;
  metricName: string;
};

/** Power sums over one score partition. `min`/`max` are ignored when count=0. */
type JudgeScorePowerSums = {
  count: number;
  sum: number;
  sumSq: number;
  min: number;
  max: number;
};

class JudgeScoreAggregator {
  private readonly data = new Map<
    DocumentType,
    Map<string, AggregatedJudgeData>
  >();

  private ensureEntry(
    documentType: DocumentType,
    aggregationKey: string,
    promptName: string,
    metricName: string
  ): AggregatedJudgeData {
    if (!this.data.has(documentType)) {
      this.data.set(documentType, new Map());
    }
    const judgeMap = this.data.get(documentType)!;
    let judgeData = judgeMap.get(aggregationKey);
    if (judgeData === undefined) {
      judgeData = {
        scores: [],
        count: 0,
        sum: 0,
        sumSq: 0,
        min: Number.POSITIVE_INFINITY,
        max: Number.NEGATIVE_INFINITY,
        documentIds: new Set(),
        promptName,
        metricName,
      };
      judgeMap.set(aggregationKey, judgeData);
    }
    return judgeData;
  }

  /** Fold a single score (per-score path — keeps the raw `scores` array). */
  addScore(
    documentType: DocumentType,
    aggregationKey: string,
    promptName: string,
    metricName: string,
    score: number,
    documentId: string
  ): void {
    const judgeData = this.ensureEntry(
      documentType,
      aggregationKey,
      promptName,
      metricName
    );
    judgeData.scores.push(score);
    judgeData.count += 1;
    judgeData.sum += score;
    judgeData.sumSq += score * score;
    judgeData.min = Math.min(judgeData.min, score);
    judgeData.max = Math.max(judgeData.max, score);
    judgeData.documentIds.add(documentId);
  }

  /**
   * Fold a pre-aggregated group (power sums over one
   * `(documentType, metricName, promptId, caseId)` partition) into the
   * running per-`(documentType, aggregationKey)` accumulator. Multiple groups
   * can map to the same aggregationKey (collision resolution), so sums are
   * combined and min/max reduced. Does NOT populate `scores`.
   */
  addGroup(
    documentType: DocumentType,
    aggregationKey: string,
    promptName: string,
    metricName: string,
    group: JudgeScorePowerSums,
    documentIds: Iterable<string>
  ): void {
    if (group.count === 0) {
      return;
    }
    const judgeData = this.ensureEntry(
      documentType,
      aggregationKey,
      promptName,
      metricName
    );
    judgeData.count += group.count;
    judgeData.sum += group.sum;
    judgeData.sumSq += group.sumSq;
    judgeData.min = Math.min(judgeData.min, group.min);
    judgeData.max = Math.max(judgeData.max, group.max);
    for (const id of documentIds) {
      judgeData.documentIds.add(id);
    }
  }

  getResults(): Map<DocumentType, Map<string, AggregatedJudgeData>> {
    return this.data;
  }
}

/** Minimal identity a row/group needs for aggregation-key + route-name resolution. */
type JudgeScoreIdentity = {
  caseId: string;
  metricName: string;
  promptId: string | null;
};

/**
 * For each row, determine the aggregation key.
 * If the same metricName appears from multiple distinct promptIds, use
 * "{normalizedPromptName}-{metricName}" as the key to disambiguate.
 */
function resolveAggregationKey(
  row: JudgeScoreIdentity,
  collisionMetrics: Set<string>,
  promptNameById: Map<string, string>
): string {
  if (!collisionMetrics.has(row.metricName)) {
    return row.metricName;
  }
  const promptName = row.promptId
    ? (promptNameById.get(row.promptId) ?? row.metricName)
    : "unknown";
  return `${promptName}-${row.metricName}`;
}

function resolvePromptRouteName(
  row: JudgeScoreIdentity,
  promptNameById: Map<string, string>
): string {
  if (row.promptId) {
    return promptNameById.get(row.promptId) ?? normalizeJudgeName(row.caseId);
  }

  return normalizeJudgeName(row.caseId);
}

/**
 * Aggregates JudgeScore rows into a nested map keyed by artifact type and metricName.
 *
 * @param judgeScores - Array of JudgeScore rows with evaluation and artifact relations
 * @param collisionMetrics - Set of metricNames that appear from multiple distinct promptIds
 * @param promptNameById - Map from promptId to normalized prompt name (for collision resolution)
 * @returns Nested map structure: documentType -> metricName -> { scores, documentIds }
 */
export function aggregateJudgeScoreRows(
  judgeScores: JudgeScoreInput[],
  collisionMetrics: Set<string> = new Set(),
  promptNameById: Map<string, string> = new Map()
): Map<DocumentType, Map<string, AggregatedJudgeData>> {
  const aggregator = new JudgeScoreAggregator();

  for (const row of judgeScores) {
    const aggregationKey = resolveAggregationKey(
      row,
      collisionMetrics,
      promptNameById
    );
    const promptName = resolvePromptRouteName(row, promptNameById);
    aggregator.addScore(
      row.evaluation.documentType,
      aggregationKey,
      promptName,
      row.metricName,
      row.score,
      row.evaluation.entityId
    );
  }

  return aggregator.getResults();
}

/**
 * Aggregates pre-grouped judge-score power sums into the same nested map that
 * {@link aggregateJudgeScoreRows} produces from raw scores — but bounded by the
 * number of DB groups rather than the full score population.
 */
export function aggregateJudgeScoreGroups(
  groups: JudgeScoreGroup[],
  collisionMetrics: Set<string> = new Set(),
  promptNameById: Map<string, string> = new Map()
): Map<DocumentType, Map<string, AggregatedJudgeData>> {
  const aggregator = new JudgeScoreAggregator();

  for (const group of groups) {
    const aggregationKey = resolveAggregationKey(
      group,
      collisionMetrics,
      promptNameById
    );
    const promptName = resolvePromptRouteName(group, promptNameById);
    aggregator.addGroup(
      group.documentType,
      aggregationKey,
      promptName,
      group.metricName,
      {
        count: group.count,
        sum: group.sum,
        sumSq: group.sumSq,
        min: group.min,
        max: group.max,
      },
      group.documentIds
    );
  }

  return aggregator.getResults();
}

/** Collects all unique artifact IDs from the aggregator across all types and judges. */
function collectAllArtifactIds(
  aggregator: Map<DocumentType, Map<string, AggregatedJudgeData>>
): string[] {
  const allIds = new Set<string>();
  for (const judgeMap of aggregator.values()) {
    for (const judgeData of judgeMap.values()) {
      for (const id of judgeData.documentIds) {
        allIds.add(id);
      }
    }
  }
  return Array.from(allIds);
}

/**
 * Population standard deviation derived from power sums.
 *
 * Algebraically equal to {@link computeStdDev} (`sqrt(mean((v-mean)^2))`) via
 * `variance = E[x^2] - E[x]^2`. The `Math.max(0, …)` guards against a tiny
 * negative variance from floating-point cancellation.
 */
function stdDevFromPowerSums(
  count: number,
  sum: number,
  sumSq: number
): number {
  if (count === 0) {
    return 0;
  }
  const mean = sum / count;
  const variance = Math.max(0, sumSq / count - mean * mean);
  return Math.sqrt(variance);
}

/** Computes aggregate stats for a single judge given its power sums and human ratings lookup. */
function computeJudgeStats(
  judgeDisplayName: string,
  judgeData: AggregatedJudgeData,
  humanRatingsByArtifact: Map<string, number[]>,
  judgeDescriptionByMetricName: Map<string, string>
): JudgeAggregateStats | null {
  const count = judgeData.count;

  if (count === 0) {
    return null;
  }

  const min = judgeData.min;
  const max = judgeData.max;
  const mean = judgeData.sum / count;
  const stdDev = stdDevFromPowerSums(count, judgeData.sum, judgeData.sumSq);

  // Pool all human scores across this judge's artifacts
  const judgeHumanScores: number[] = [];
  for (const artifactId of judgeData.documentIds) {
    const artifactScores = humanRatingsByArtifact.get(artifactId);
    if (artifactScores) {
      judgeHumanScores.push(...artifactScores);
    }
  }

  return {
    judgeName: judgeDisplayName,
    promptName: judgeData.promptName,
    metricName: judgeData.metricName,
    displayMetricName: judgeDisplayName,
    description: judgeDescriptionByMetricName.get(judgeDisplayName) ?? null,
    documentsEvaluated: judgeData.documentIds.size,
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
  types: DocumentType[],
  artifactIds: string[]
): Promise<{
  humanRatingsByType: Map<DocumentType, number>;
  humanCommentsByType: Map<DocumentType, number>;
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
  types: DocumentType[],
  artifactIds: string[]
): Promise<{
  humanRatingsByType: Map<DocumentType, number>;
  humanCommentsByType: Map<DocumentType, number>;
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
  // DISTINCT ON collapses the unbounded version history to the latest row per
  // raw prompt name in the DB, instead of shipping every (name × version) row.
  // The JS reduce below is still required because distinct raw names can
  // normalize to the same judge name; the cross-name latest-version comparison
  // is preserved by selecting each raw name's highest version here.
  const judgePrompts = await withDb((db) =>
    db.$queryRaw<{ name: string; description: string; version: number }[]>(
      Prisma.sql`
        SELECT DISTINCT ON ("name")
          "name" AS name,
          "description" AS description,
          "version" AS version
        FROM "prompt_registry"
        WHERE "organization_id" = ${organizationId}::uuid
          AND "prompt_type" = ${PromptType.JUDGE}::"PromptType"
        ORDER BY "name" ASC, "version" DESC
      `
    )
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
 * DB-side pre-aggregation for {@link judgesAnalyticsService.getAggregateStats}.
 *
 * Groups judge scores by `(subtype, metric_name, prompt_id, case_id)` and emits
 * power sums (COUNT / SUM(score) / SUM(score^2) / MIN / MAX) plus the DISTINCT
 * artifact ids per group. Scoping (org / reportType / DOCUMENT / evaluation
 * createdAt window) is applied in SQL, so only one bounded row per group crosses
 * the wire — never the full per-score population.
 */
async function getAggregateJudgeScoreGroups(
  organizationId: string,
  startDate: Date,
  endDate: Date,
  reportType: EvaluationReportType
): Promise<JudgeScoreGroup[]> {
  const rows = await withDb((db) =>
    db.$queryRaw<
      {
        caseId: string;
        metricName: string;
        promptId: string | null;
        subtype: string;
        count: number;
        sum: number;
        sumSq: number;
        min: number;
        max: number;
        documentIds: string[];
      }[]
    >(
      Prisma.sql`
        SELECT
          js."case_id" AS "caseId",
          js."metric_name" AS "metricName",
          js."prompt_id"::text AS "promptId",
          a."subtype"::text AS "subtype",
          COUNT(*)::int AS "count",
          SUM(js."score")::double precision AS "sum",
          SUM(js."score" * js."score")::double precision AS "sumSq",
          MIN(js."score")::double precision AS "min",
          MAX(js."score")::double precision AS "max",
          array_agg(DISTINCT ae."artifact_id"::text) AS "documentIds"
        FROM "judge_scores" js
        JOIN "artifact_evaluations" ae ON ae."id" = js."evaluation_id"
        JOIN "artifacts" a ON a."id" = ae."artifact_id"
        WHERE ae."organization_id" = ${organizationId}::uuid
          AND ae."report_type" = ${reportType}::"EvaluationReportType"
          AND ae."created_at" >= ${startDate}
          AND ae."created_at" <= ${endDate}
          AND a."type" = ${ArtifactType.DOCUMENT}::"ArtifactType"
          AND a."subtype" IS NOT NULL
        GROUP BY js."case_id", js."metric_name", js."prompt_id", a."subtype"
      `
    )
  );

  return rows.map((row) => ({
    caseId: row.caseId,
    metricName: row.metricName,
    promptId: row.promptId,
    documentType: row.subtype as DocumentType,
    count: toNumber(row.count),
    sum: toNumber(row.sum),
    sumSq: toNumber(row.sumSq),
    min: toNumber(row.min),
    max: toNumber(row.max),
    documentIds: row.documentIds,
  }));
}

/** Per-prompt-version power moments plus the min/max used by the version panel. */
type JudgeDetailMoments = ScorePowerMoments & { min: number; max: number };

/**
 * DB-side per-promptId power-sum aggregation for
 * {@link judgesAnalyticsService.getJudgeDetail}. Emits COUNT / SUM(score) /
 * SUM(score^2) / SUM(score^3) / SUM(score^4) / MIN / MAX and the extreme-score
 * count per matching prompt version, so the moments (mean/stdDev/skew/kurtosis/
 * bimodality/certainty) are reconstructed from a handful of grouped rows rather
 * than the full judge-score population. Scoping matches the prior in-app filter.
 */
async function getJudgeDetailPowerMoments(
  organizationId: string,
  reportType: EvaluationReportType,
  promptIds: string[]
): Promise<Map<string, JudgeDetailMoments>> {
  if (promptIds.length === 0) {
    return new Map();
  }

  const promptIdCsv = Prisma.join(
    promptIds.map((id) => Prisma.sql`${id}::uuid`)
  );
  const extremeHigh = JUDGE_RADAR_METRICS.certainty.extremeHighScore;
  const extremeLow = JUDGE_RADAR_METRICS.certainty.extremeLowScore;

  const rows = await withDb((db) =>
    db.$queryRaw<
      {
        promptId: string;
        count: number;
        sum: number;
        sumSq: number;
        sum3: number;
        sum4: number;
        min: number;
        max: number;
        extremeCount: number;
      }[]
    >(
      Prisma.sql`
        SELECT
          js."prompt_id"::text AS "promptId",
          COUNT(*)::int AS "count",
          SUM(js."score")::double precision AS "sum",
          SUM(js."score" * js."score")::double precision AS "sumSq",
          SUM(js."score" * js."score" * js."score")::double precision AS "sum3",
          SUM(js."score" * js."score" * js."score" * js."score")::double precision AS "sum4",
          MIN(js."score")::double precision AS "min",
          MAX(js."score")::double precision AS "max",
          COUNT(*) FILTER (
            WHERE js."score" > ${extremeHigh} OR js."score" < ${extremeLow}
          )::int AS "extremeCount"
        FROM "judge_scores" js
        JOIN "artifact_evaluations" ae ON ae."id" = js."evaluation_id"
        JOIN "artifacts" a ON a."id" = ae."artifact_id"
        WHERE js."prompt_id" IN (${promptIdCsv})
          AND ae."organization_id" = ${organizationId}::uuid
          AND ae."report_type" = ${reportType}::"EvaluationReportType"
          AND a."type" = ${ArtifactType.DOCUMENT}::"ArtifactType"
        GROUP BY js."prompt_id"
      `
    )
  );

  const byPromptId = new Map<string, JudgeDetailMoments>();
  for (const row of rows) {
    byPromptId.set(row.promptId, {
      count: toNumber(row.count),
      sum: toNumber(row.sum),
      sumSq: toNumber(row.sumSq),
      sum3: toNumber(row.sum3),
      sum4: toNumber(row.sum4),
      extremeCount: toNumber(row.extremeCount),
      min: toNumber(row.min),
      max: toNumber(row.max),
    });
  }
  return byPromptId;
}

/** One paginated, delta-ranked judge-score row (raw-query shape). */
type JudgeScoresPageRow = {
  judgeScoreId: string;
  metricName: string;
  documentId: string;
  subtype: string;
  documentTitle: string;
  documentSlug: string | null;
  judgeScore: number;
  avgUserRating: number;
  userRatingCount: number;
  delta: number;
  evaluatedAt: Date;
  totalRows: number;
  ratedRows: number;
};

/**
 * DB-side, delta-ranked, paginated page for
 * {@link judgesAnalyticsService.getJudgeScores}.
 *
 * Per judge score: `avgUserRating` = AVG(human score) when rated else the judge
 * score (concurrence default), `delta` = |avgUserRating − score| when rated else
 * 0. Ordered by `delta DESC, score DESC` (unrated rows last), with `id` as a
 * deterministic final tiebreak. `COUNT(*) OVER()` / `COUNT(*) FILTER (…) OVER()`
 * carry the full-population totals so coverage is exact without a second pass.
 */
async function getJudgeScoresPage(
  organizationId: string,
  reportType: EvaluationReportType,
  promptIds: string[],
  limit: number,
  offset: number
): Promise<JudgeScoresPageRow[]> {
  if (promptIds.length === 0) {
    return [];
  }
  const promptIdCsv = Prisma.join(
    promptIds.map((id) => Prisma.sql`${id}::uuid`)
  );

  return await withDb((db) =>
    db.$queryRaw<JudgeScoresPageRow[]>(
      Prisma.sql`
        WITH scored AS (
          SELECT
            js."id" AS "judgeScoreId",
            js."metric_name" AS "metricName",
            a."id" AS "documentId",
            a."subtype"::text AS "subtype",
            a."name" AS "documentTitle",
            a."slug" AS "documentSlug",
            js."score" AS "judgeScore",
            js."created_at" AS "evaluatedAt",
            COUNT(hs."id") AS "userRatingCount",
            CASE
              WHEN COUNT(hs."id") > 0 THEN AVG(hs."score")
              ELSE js."score"
            END AS "avgUserRating",
            CASE
              WHEN COUNT(hs."id") > 0
                THEN ABS(AVG(hs."score") - js."score")
              ELSE 0
            END AS "delta"
          FROM "judge_scores" js
          JOIN "artifact_evaluations" ae ON ae."id" = js."evaluation_id"
          JOIN "artifacts" a ON a."id" = ae."artifact_id"
          LEFT JOIN "judge_human_scores" hs ON hs."judge_score_id" = js."id"
          WHERE js."prompt_id" IN (${promptIdCsv})
            AND ae."organization_id" = ${organizationId}::uuid
            AND ae."report_type" = ${reportType}::"EvaluationReportType"
            AND a."type" = ${ArtifactType.DOCUMENT}::"ArtifactType"
            AND a."subtype" IS NOT NULL
          GROUP BY js."id", js."metric_name", a."id", a."subtype",
                   a."name", a."slug", js."score", js."created_at"
        )
        SELECT
          "judgeScoreId",
          "metricName",
          "documentId",
          "subtype",
          "documentTitle",
          "documentSlug",
          "judgeScore"::double precision AS "judgeScore",
          "avgUserRating"::double precision AS "avgUserRating",
          "userRatingCount"::int AS "userRatingCount",
          "delta"::double precision AS "delta",
          "evaluatedAt",
          COUNT(*) OVER ()::int AS "totalRows",
          COUNT(*) FILTER (WHERE "userRatingCount" > 0) OVER ()::int AS "ratedRows"
        FROM scored
        ORDER BY "delta" DESC, "judgeScore" DESC, "judgeScoreId" ASC
        LIMIT ${limit} OFFSET ${offset}
      `
    )
  );
}

/**
 * Full-population totals (total rows + rated rows) for
 * {@link judgesAnalyticsService.getJudgeScores}, used only when the requested
 * page is empty (out-of-range or zero scores) and the windowed counts on the
 * page rows are therefore unavailable.
 */
async function getJudgeScoresTotals(
  organizationId: string,
  reportType: EvaluationReportType,
  promptIds: string[]
): Promise<{ totalRows: number; ratedRows: number }> {
  if (promptIds.length === 0) {
    return { totalRows: 0, ratedRows: 0 };
  }
  const promptIdCsv = Prisma.join(
    promptIds.map((id) => Prisma.sql`${id}::uuid`)
  );

  const rows = await withDb((db) =>
    db.$queryRaw<{ totalRows: number; ratedRows: number }[]>(
      Prisma.sql`
        WITH scored AS (
          SELECT
            js."id" AS "judgeScoreId",
            COUNT(hs."id") AS "userRatingCount"
          FROM "judge_scores" js
          JOIN "artifact_evaluations" ae ON ae."id" = js."evaluation_id"
          JOIN "artifacts" a ON a."id" = ae."artifact_id"
          LEFT JOIN "judge_human_scores" hs ON hs."judge_score_id" = js."id"
          WHERE js."prompt_id" IN (${promptIdCsv})
            AND ae."organization_id" = ${organizationId}::uuid
            AND ae."report_type" = ${reportType}::"EvaluationReportType"
            AND a."type" = ${ArtifactType.DOCUMENT}::"ArtifactType"
            AND a."subtype" IS NOT NULL
          GROUP BY js."id"
        )
        SELECT
          COUNT(*)::int AS "totalRows",
          COUNT(*) FILTER (WHERE "userRatingCount" > 0)::int AS "ratedRows"
        FROM scored
      `
    )
  );

  const row = rows[0];
  return {
    totalRows: toNumber(row?.totalRows),
    ratedRows: toNumber(row?.ratedRows),
  };
}

/**
 * Returns the description for a single judge row/group, consulting promptId first
 * then falling back to the prompt-name-based map via caseId.
 */
function resolveMetricDescription(
  js: JudgeScoreIdentity,
  descriptionById: Map<string, string>,
  judgeDescriptionByPromptName: Map<string, string>
): string | undefined {
  if (js.promptId) {
    const description = descriptionById.get(js.promptId);
    if (description) {
      return description;
    }
  }
  return judgeDescriptionByPromptName.get(normalizeJudgeName(js.caseId));
}

/**
 * Populates a metricName → description map for a set of JudgeScoreInput rows.
 * Uses the provided descriptionById map for promptId lookups, falling back to
 * prompt-name-based descriptions via caseId.
 */
function populateMetricDescriptionMap(
  map: Map<string, string>,
  judgeScores: JudgeScoreIdentity[],
  descriptionById: Map<string, string>,
  judgeDescriptionByPromptName: Map<string, string>,
  collisionMetrics: Set<string>,
  promptNameById: Map<string, string>
): void {
  for (const js of judgeScores) {
    const key = resolveAggregationKey(js, collisionMetrics, promptNameById);
    if (map.has(key)) {
      continue;
    }
    const description = resolveMetricDescription(
      js,
      descriptionById,
      judgeDescriptionByPromptName
    );
    if (description) {
      map.set(key, description);
    }
  }
}

type CollisionResolution = {
  collisionMetrics: Set<string>;
  promptNameById: Map<string, string>;
};

/**
 * Detects metrics that appear from multiple distinct promptIds and builds
 * a promptId → normalizedName map for disambiguation. Works over either raw
 * per-score rows or pre-aggregated groups (both are {@link JudgeScoreIdentity}).
 */
function detectMetricCollisions(
  rows: JudgeScoreIdentity[]
): CollisionResolution {
  const metricNameToPromptIds = new Map<string, Set<string>>();
  for (const row of rows) {
    if (row.promptId) {
      const ids =
        metricNameToPromptIds.get(row.metricName) ?? new Set<string>();
      ids.add(row.promptId);
      metricNameToPromptIds.set(row.metricName, ids);
    }
  }

  const collisionMetrics = new Set<string>();
  for (const [metricName, promptIds] of metricNameToPromptIds) {
    if (promptIds.size > 1) {
      collisionMetrics.add(metricName);
    }
  }

  const promptNameById = new Map<string, string>();
  if (collisionMetrics.size > 0) {
    for (const row of rows) {
      if (row.promptId && !promptNameById.has(row.promptId)) {
        promptNameById.set(row.promptId, normalizeJudgeName(row.caseId));
      }
    }
  }

  return { collisionMetrics, promptNameById };
}

/**
 * Builds a metricName → description map by looking up prompt descriptions for each promptId
 * found in the judge scores. Falls back to the prompt-name-based descriptions when a
 * promptId is not present.
 */
async function buildMetricNameDescriptionMap(
  judgeScores: JudgeScoreIdentity[],
  judgeDescriptionByPromptName: Map<string, string>,
  collisionMetrics: Set<string>,
  promptNameById: Map<string, string>
): Promise<Map<string, string>> {
  const promptIds = [
    ...new Set(
      judgeScores
        .map((js) => js.promptId)
        .filter((id): id is string => id !== null)
    ),
  ];

  const map = new Map<string, string>();
  let descriptionById = new Map<string, string>();

  if (promptIds.length > 0) {
    const prompts = await withDb((db) =>
      db.prompt.findMany({
        where: { id: { in: promptIds } },
        select: { id: true, description: true },
      })
    );
    descriptionById = new Map(prompts.map((p) => [p.id, p.description]));
  }

  populateMetricDescriptionMap(
    map,
    judgeScores,
    descriptionById,
    judgeDescriptionByPromptName,
    collisionMetrics,
    promptNameById
  );

  return map;
}

/**
 * Aggregation service for judges analytics.
 *
 * Queries JudgeScore rows within a date range and computes aggregate statistics
 * (min, mean, max, stdDev) grouped by artifact type and metricName.
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

    // Aggregate JudgeScore rows DB-side, grouped by
    // (subtype, metric_name, prompt_id, case_id), joined through
    // ArtifactEvaluation → Artifact. We push COUNT / SUM(score) / SUM(score^2)
    // / MIN / MAX to the database so app memory stays bounded by the number of
    // distinct groups instead of the full per-score population. array_agg of
    // the DISTINCT artifact ids per group (bounded by distinct scored
    // artifacts) preserves documentsEvaluated + human-rating pooling. The
    // evaluation-level createdAt window and DOCUMENT/reportType/org scoping
    // match the prior in-app filters exactly.
    const judgeScoreGroups = await getAggregateJudgeScoreGroups(
      organizationId,
      startDate,
      endDate,
      reportType
    );

    if (judgeScoreGroups.length === 0) {
      log.warn("No judge scores found for judges analytics query", {
        organizationId,
        startDate: startDate.toISOString(),
        endDate: endDate.toISOString(),
        reportType,
      });
      return { reportType, groups: [] };
    }

    // Detect collisions: same metricName from multiple distinct promptIds
    const { collisionMetrics, promptNameById } =
      detectMetricCollisions(judgeScoreGroups);

    // Aggregate power sums by artifact type and metricName
    const aggregator = aggregateJudgeScoreGroups(
      judgeScoreGroups,
      collisionMetrics,
      promptNameById
    );

    // Build metricName → description map for the description lookup in computeJudgeStats
    const judgeDescriptionByMetricName = await buildMetricNameDescriptionMap(
      judgeScoreGroups,
      judgeDescriptionByPromptName,
      collisionMetrics,
      promptNameById
    );

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

    // Compute statistics for each judge within each document type
    const groups: DocumentTypeGroup[] = [];

    for (const [docType, judgeMap] of aggregator) {
      const judges: JudgeAggregateStats[] = [];

      for (const [judgeName, judgeData] of judgeMap) {
        const stats = computeJudgeStats(
          judgeName,
          judgeData,
          humanRatingsByArtifact,
          judgeDescriptionByMetricName
        );
        if (stats) {
          judges.push(stats);
        }
      }

      // Sort judges by mean score in descending order (highest mean first)
      judges.sort((a, b) => b.mean - a.mean);

      groups.push({
        documentType: docType,
        judges,
        humanRatingsCount: humanRatingsByType.get(docType) ?? 0,
        humanCommentsCount: humanCommentsByType.get(docType) ?? 0,
      });
    }

    return { reportType, groups };
  },

  /**
   * Get artifact creation counts grouped by time bucket and artifact type.
   * Aggregates in the database with date_trunc + COUNT + GROUP BY so only the
   * already-bucketed rows are shipped back, instead of every matching artifact.
   * Truncation is done in UTC to match the prior in-memory bucketing semantics.
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
    groupBy: DocumentCountsGroupBy
  ): Promise<DocumentCountsResponse> {
    const rows = await withDb((db) =>
      db.$queryRaw<{ bucket: string; subtype: string; count: number }[]>(
        Prisma.sql`
          SELECT
            to_char(
              date_trunc(${groupBy}, "created_at" AT TIME ZONE 'UTC'),
              'YYYY-MM-DD'
            ) AS bucket,
            "subtype" AS subtype,
            COUNT(*)::int AS count
          FROM "artifacts"
          WHERE "organization_id" = ${organizationId}::uuid
            AND "type" = ${ArtifactType.DOCUMENT}::"ArtifactType"
            AND "subtype" IS NOT NULL
            AND "created_at" >= ${startDate}
            AND "created_at" <= ${endDate}
          GROUP BY bucket, "subtype"
          ORDER BY bucket ASC
        `
      )
    );

    const bucketOrder: string[] = [];
    const countsByBucket = new Map<string, Record<string, number>>();
    for (const { bucket, subtype, count } of rows) {
      if (count <= 0) {
        continue;
      }
      let countsByType = countsByBucket.get(bucket);
      if (countsByType === undefined) {
        countsByType = {};
        countsByBucket.set(bucket, countsByType);
        bucketOrder.push(bucket);
      }
      countsByType[subtype] = count;
    }

    const buckets: DocumentCountBucket[] = bucketOrder.map((bucket) => ({
      bucket,
      countsByType: countsByBucket.get(bucket) as Record<string, number>,
    }));
    return { buckets };
  },

  /**
   * Get detailed statistics for a single judge identified by normalized prompt name.
   *
   * @param organizationId - Organization ID to scope the query
   * @param promptName - URL-safe normalized prompt name (e.g. "clarity")
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

    // 3. Aggregate score power sums DB-side, grouped by promptId, scoped to org
    // / reportType / DOCUMENT. Only one bounded row per prompt version crosses
    // the wire — the full per-score population never enters app memory. The
    // `promptId IN (…)` filter guarantees every returned group belongs to a
    // matching prompt (there are no unknown-version scores under that filter).
    const momentsByPromptId = await getJudgeDetailPowerMoments(
      organizationId,
      reportType,
      promptIds
    );

    // Overall = roll-up of every matching prompt version.
    let overall = EMPTY_POWER_MOMENTS;
    for (const moments of momentsByPromptId.values()) {
      overall = addPowerMoments(overall, moments);
    }
    const scoreCount = overall.count;
    const unknownVersionScoreCount = 0;

    // 4. Compute radar axes (null when insufficient scores)
    let radarAxes: RadarAxes | null = null;
    let labels: CharacteristicLabel[] = [];

    if (scoreCount >= JUDGE_THRESHOLDS.minScoreCount) {
      const mean = meanFromMoments(overall);
      const stdDev = stdDevFromMoments(overall);
      const bimodality = bimodalityFromMoments(overall);
      const certaintyFraction = certaintyFractionFromMoments(overall);

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
    const promptVersions: JudgePromptVersion[] = [];
    for (const prompt of matchingPrompts) {
      const vMoments = momentsByPromptId.get(prompt.id);
      if (!vMoments || vMoments.count === 0) {
        continue;
      }

      const vMean = meanFromMoments(vMoments);
      const vStdDev = stdDevFromMoments(vMoments);

      let versionRadarAxes: RadarAxes | null = null;
      if (vMoments.count >= JUDGE_THRESHOLDS.minScoreCount) {
        const vBimodality = bimodalityFromMoments(vMoments);
        const vCertaintyFraction = certaintyFractionFromMoments(vMoments);
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
        scoreCount: vMoments.count,
        mean: vMean,
        stdDev: vStdDev,
        min: vMoments.min,
        max: vMoments.max,
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

    // The relation-derived `delta` sort (|avgUserRating − score|) cannot be
    // expressed by Prisma's `orderBy`, so a bounded `findMany`/`take` would
    // corrupt both the ranking and the coverage totals. Instead we push the
    // human-rating aggregation, delta computation, `ORDER BY delta DESC, score
    // DESC`, windowed COUNT(*) OVER() and LIMIT/OFFSET into one `$queryRaw`, so
    // exactly one page (+ full-population totals) crosses the wire.
    const offset = (page - 1) * pageSize;
    const rawRows = await getJudgeScoresPage(
      organizationId,
      reportType,
      promptIds,
      pageSize,
      offset
    );

    if (rawRows.length === 0) {
      // No page rows: either there are truly zero scores, or the requested page
      // is past the end. Re-derive the population totals cheaply so pagination
      // metadata stays correct for out-of-range pages.
      const totals = await getJudgeScoresTotals(
        organizationId,
        reportType,
        promptIds
      );
      const totalRows = totals.totalRows;
      const ratedRows = totals.ratedRows;
      return {
        rows: [],
        totalDocuments: totalRows,
        ratedDocuments: ratedRows,
        coveragePct: totalRows > 0 ? (ratedRows / totalRows) * 100 : 0,
        pagination: {
          page,
          pageSize,
          totalRows,
          totalPages: Math.ceil(totalRows / pageSize),
        },
      };
    }

    // Population totals come back on every windowed row (COUNT(*) OVER()).
    const totalRows = toNumber(rawRows[0].totalRows);
    const ratedRows = toNumber(rawRows[0].ratedRows);

    const rows: JudgeScoreRow[] = rawRows.map((r) => ({
      judgeScoreId: r.judgeScoreId,
      metricName: r.metricName,
      documentId: r.documentId,
      documentType: r.subtype as DocumentType,
      documentTitle: r.documentTitle,
      documentSlug: r.documentSlug ?? "",
      judgeScore: toNumber(r.judgeScore),
      avgUserRating: toNumber(r.avgUserRating),
      userRatingCount: toNumber(r.userRatingCount),
      delta: toNumber(r.delta),
      evaluatedAt: r.evaluatedAt.toISOString(),
    }));

    return {
      rows,
      totalDocuments: totalRows,
      ratedDocuments: ratedRows,
      coveragePct: totalRows > 0 ? (ratedRows / totalRows) * 100 : 0,
      pagination: {
        page,
        pageSize,
        totalRows,
        totalPages: Math.ceil(totalRows / pageSize),
      },
    };
  },
};

// ---------------------------------------------------------------------------
// Statistical helper functions
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Power-sum moment reconstruction
//
// These derive the exact same mean / stdDev / skewness / excess-kurtosis /
// bimodality / certainty values as the array-based helpers above, but from
// DB-computed power sums — so a caller never has to materialize the full score
// population. Central moments are recovered from raw power sums via the
// standard binomial expansions:
//   m2 = Σx²/n − μ²
//   m3 = Σx³/n − 3μ·Σx²/n + 2μ³
//   m4 = Σx⁴/n − 4μ·Σx³/n + 6μ²·Σx²/n − 3μ⁴
// Skewness = m3/σ³ and excess kurtosis = m4/σ⁴ − 3 (population, matching the
// array implementations). The `n<3` / `n<4` / `σ===0` guards are replicated so
// the outputs stay bit-for-bit identical to the prior in-app computation.
// ---------------------------------------------------------------------------

/** Raw power sums (+ extreme count) over one score population. */
export type ScorePowerMoments = {
  count: number;
  sum: number;
  sumSq: number;
  sum3: number;
  sum4: number;
  extremeCount: number;
};

export const EMPTY_POWER_MOMENTS: ScorePowerMoments = {
  count: 0,
  sum: 0,
  sumSq: 0,
  sum3: 0,
  sum4: 0,
  extremeCount: 0,
};

/** Combine two power-sum accumulators (used to roll per-version → overall). */
export function addPowerMoments(
  a: ScorePowerMoments,
  b: ScorePowerMoments
): ScorePowerMoments {
  return {
    count: a.count + b.count,
    sum: a.sum + b.sum,
    sumSq: a.sumSq + b.sumSq,
    sum3: a.sum3 + b.sum3,
    sum4: a.sum4 + b.sum4,
    extremeCount: a.extremeCount + b.extremeCount,
  };
}

function meanFromMoments(m: ScorePowerMoments): number {
  return m.count === 0 ? 0 : m.sum / m.count;
}

function stdDevFromMoments(m: ScorePowerMoments): number {
  return stdDevFromPowerSums(m.count, m.sum, m.sumSq);
}

function skewnessFromMoments(m: ScorePowerMoments, stdDev: number): number {
  const n = m.count;
  if (n < 3 || stdDev === 0) {
    return 0;
  }
  const mean = m.sum / n;
  const m3 = m.sum3 / n - (3 * mean * m.sumSq) / n + 2 * mean ** 3;
  return m3 / stdDev ** 3;
}

function excessKurtosisFromMoments(
  m: ScorePowerMoments,
  stdDev: number
): number {
  const n = m.count;
  if (n < 4 || stdDev === 0) {
    return 0;
  }
  const mean = m.sum / n;
  const m4 =
    m.sum4 / n -
    (4 * mean * m.sum3) / n +
    (6 * mean ** 2 * m.sumSq) / n -
    3 * mean ** 4;
  return m4 / stdDev ** 4 - 3;
}

function bimodalityFromMoments(m: ScorePowerMoments): number {
  const n = m.count;
  if (n < 4) {
    return 0;
  }
  const stdDev = stdDevFromMoments(m);
  if (stdDev === 0) {
    return 0;
  }
  const skewness = skewnessFromMoments(m, stdDev);
  const excessKurtosis = excessKurtosisFromMoments(m, stdDev);
  const denominator = excessKurtosis + (3 * (n - 1) ** 2) / ((n - 2) * (n - 3));
  if (denominator <= 0) {
    return 0;
  }
  const bc = (skewness ** 2 + 1) / denominator;
  return clamp(bc, 0, 1);
}

function certaintyFractionFromMoments(m: ScorePowerMoments): number {
  return m.count === 0 ? 0 : m.extremeCount / m.count;
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
