/**
 * Human-rating reads for judges-analytics: per-type rating/comment counts and
 * normalized (score/5) ratings per artifact, for both the plan and code lanes.
 */
import { LinkType } from "@repo/api/src/types/artifact";
import type { DocumentType } from "@repo/api/src/types/document";
import { ArtifactType, withDb } from "@repo/database";
import { computeMean, computeStdDev } from "./score-statistics";

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

/** Computes human rating stats from pooled normalized scores. Returns all-null when no scores. */
export function computeHumanStats(scores: number[]): {
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

export async function getPlanHumanData(
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

export async function getCodeHumanData(
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
