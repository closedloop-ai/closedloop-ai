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
import { computeMean as computeMeanFromUtils } from "@repo/api/src/utils/math";
import { ArtifactType, Prisma, PromptType, withDb } from "@repo/database";
import { log } from "@repo/observability/log";
import { normalizeJudgeName } from "@/lib/judge-name-utils";

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

/** Aggregates judge scores by document type and judge name. */
type AggregatedJudgeData = {
  scores: number[];
  documentIds: Set<string>;
  promptName: string;
  metricName: string;
};

class JudgeScoreAggregator {
  private readonly data = new Map<
    DocumentType,
    Map<string, AggregatedJudgeData>
  >();

  addScore(
    documentType: DocumentType,
    aggregationKey: string,
    promptName: string,
    metricName: string,
    score: number,
    documentId: string
  ): void {
    if (!this.data.has(documentType)) {
      this.data.set(documentType, new Map());
    }

    const judgeMap = this.data.get(documentType)!;
    if (!judgeMap.has(aggregationKey)) {
      judgeMap.set(aggregationKey, {
        scores: [],
        documentIds: new Set(),
        promptName,
        metricName,
      });
    }

    const judgeData = judgeMap.get(aggregationKey)!;
    judgeData.scores.push(score);
    judgeData.documentIds.add(documentId);
  }

  getResults(): Map<DocumentType, Map<string, AggregatedJudgeData>> {
    return this.data;
  }
}

/**
 * For each row, determine the aggregation key.
 * If the same metricName appears from multiple distinct promptIds, use
 * "{normalizedPromptName}-{metricName}" as the key to disambiguate.
 */
function resolveAggregationKey(
  row: JudgeScoreInput,
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
  row: JudgeScoreInput,
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

/** Computes aggregate stats for a single judge given its scores and human ratings lookup. */
function computeJudgeStats(
  judgeDisplayName: string,
  judgeData: AggregatedJudgeData,
  humanRatingsByArtifact: Map<string, number[]>,
  judgeDescriptionByMetricName: Map<string, string>
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
 * Returns the description for a single JudgeScoreInput row, consulting promptId first
 * then falling back to the prompt-name-based map via caseId.
 */
function resolveMetricDescription(
  js: JudgeScoreInput,
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
  judgeScores: JudgeScoreInput[],
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
 * a promptId → normalizedName map for disambiguation.
 */
function detectMetricCollisions(
  judgeScores: JudgeScoreInput[]
): CollisionResolution {
  const metricNameToPromptIds = new Map<string, Set<string>>();
  for (const row of judgeScores) {
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
    for (const row of judgeScores) {
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
  judgeScores: JudgeScoreInput[],
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

    // Query JudgeScore rows joined through ArtifactEvaluation. The evaluation
    // now always points to an Artifact directly (no more entity polymorphism);
    // we filter DOCUMENT-typed artifacts for the legacy Plan/PRD path.
    const rawJudgeScores = await withDb((db) =>
      db.judgeScore.findMany({
        where: {
          evaluation: {
            reportType,
            organizationId,
            artifact: { type: ArtifactType.DOCUMENT },
            createdAt: { gte: startDate, lte: endDate },
          },
        },
        select: {
          caseId: true,
          metricName: true,
          promptId: true,
          score: true,
          evaluation: {
            select: {
              artifactId: true,
            },
          },
        },
      })
    );

    if (rawJudgeScores.length === 0) {
      log.warn("No judge scores found for judges analytics query", {
        organizationId,
        startDate: startDate.toISOString(),
        endDate: endDate.toISOString(),
        reportType,
      });
      return { reportType, groups: [] };
    }

    // Batch-fetch artifact subtypes to populate JudgeScoreInput
    const evalEntityIds = [
      ...new Set(rawJudgeScores.map((js) => js.evaluation.artifactId)),
    ];
    const evalArtifactRows = await withDb((db) =>
      db.artifact.findMany({
        where: {
          id: { in: evalEntityIds },
          organizationId,
          type: ArtifactType.DOCUMENT,
        },
        select: { id: true, subtype: true },
      })
    );
    const documentTypeByEntityId = new Map<string, DocumentType>(
      evalArtifactRows.flatMap((a) =>
        a.subtype === null ? [] : [[a.id, a.subtype as DocumentType] as const]
      )
    );
    const judgeScores: JudgeScoreInput[] = rawJudgeScores.flatMap((js) => {
      const documentType = documentTypeByEntityId.get(js.evaluation.artifactId);
      if (!documentType) {
        return [];
      }
      return [
        {
          ...js,
          evaluation: {
            documentId: js.evaluation.artifactId,
            entityId: js.evaluation.artifactId,
            documentType,
          },
        },
      ];
    });

    // Detect collisions: same metricName from multiple distinct promptIds
    const { collisionMetrics, promptNameById } =
      detectMetricCollisions(judgeScores);

    // Aggregate scores by artifact type and metricName
    const aggregator = aggregateJudgeScoreRows(
      judgeScores,
      collisionMetrics,
      promptNameById
    );

    // Build metricName → description map for the description lookup in computeJudgeStats
    const judgeDescriptionByMetricName = await buildMetricNameDescriptionMap(
      judgeScores,
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
    const promptIdSet = new Set(promptIds);

    // 3. Load score rows — match by promptId (relational) scoped to org.
    // Evaluations now always target an artifact directly; filter DOCUMENT
    // artifacts for the legacy Plan/PRD path.
    const allScores = await withDb((db) =>
      db.judgeScore.findMany({
        where: {
          promptId: { in: promptIds },
          evaluation: {
            reportType,
            organizationId,
            artifact: { type: ArtifactType.DOCUMENT },
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

    // Load judge scores by prompt identity, scoped to org and reportType
    const judgeScores = await withDb((db) =>
      db.judgeScore.findMany({
        where: {
          promptId: { in: promptIds },
          evaluation: {
            reportType,
            organizationId,
            artifact: { type: ArtifactType.DOCUMENT },
          },
        },
        select: {
          id: true,
          score: true,
          metricName: true,
          createdAt: true,
          evaluation: {
            select: {
              artifactId: true,
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
        totalDocuments: 0,
        ratedDocuments: 0,
        coveragePct: 0,
        pagination: { page, pageSize, totalRows: 0, totalPages: 0 },
      };
    }

    // Batch-fetch artifact data by artifactId
    const entityIds = [
      ...new Set(judgeScores.map((js) => js.evaluation.artifactId)),
    ];
    const artifactRows = await withDb((db) =>
      db.artifact.findMany({
        where: {
          id: { in: entityIds },
          organizationId,
          type: ArtifactType.DOCUMENT,
        },
        select: { id: true, subtype: true, name: true, slug: true },
      })
    );
    const artifactsByEntityId = new Map(artifactRows.map((a) => [a.id, a]));

    // 3. Build rows with concurrence default
    const rows: JudgeScoreRow[] = judgeScores.flatMap((js) => {
      const artifact = artifactsByEntityId.get(js.evaluation.artifactId);
      if (!artifact || artifact.subtype === null) {
        return [];
      }

      const humanScores = js.judgeHumanScores.map((hs) => hs.score);
      const userRatingCount = humanScores.length;
      const avgUserRating =
        userRatingCount > 0 ? computeMean(humanScores) : js.score;
      const delta =
        userRatingCount > 0 ? Math.abs(avgUserRating - js.score) : 0;

      return [
        {
          judgeScoreId: js.id,
          metricName: js.metricName,
          documentId: artifact.id,
          documentType: artifact.subtype as DocumentType,
          documentTitle: artifact.name,
          documentSlug: artifact.slug ?? "",
          judgeScore: js.score,
          avgUserRating,
          userRatingCount,
          delta,
          evaluatedAt: js.createdAt.toISOString(),
        },
      ];
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
      totalDocuments: totalArtifacts,
      ratedDocuments: ratedArtifacts,
      coveragePct,
      pagination: { page, pageSize, totalRows, totalPages },
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
