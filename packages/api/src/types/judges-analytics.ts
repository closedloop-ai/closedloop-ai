// Judges Analytics API types for aggregate statistics and reporting.
// These types are shared between the backend API and frontend query hooks.
//
// The judges analytics endpoint returns aggregate statistics for LLM judge evaluations
// grouped by artifact type and judge name.

import type { ArtifactType } from "./artifact";
import type { EvaluationReportType } from "./evaluation";

/**
 * Aggregate statistics for a single judge within an artifact type group.
 *
 * Attributes:
 * - judgeName: Name of the judge
 * - artifactsEvaluated: Number of artifacts this judge has evaluated
 * - min: Minimum score across all evaluations
 * - mean: Mean (average) score across all evaluations
 * - max: Maximum score across all evaluations
 * - stdDev: Standard deviation of scores
 *
 * Box-plot derived fields (lowerWhisker, lowerBox, median, upperBox, upperWhisker)
 * are computed in frontend, not returned by API
 */
export type JudgeAggregateStats = {
  judgeName: string;
  /** URL-safe normalized prompt name for navigation links. */
  promptName: string;
  /** Metric name for this aggregate stats entry. Used for navigation and grouping. */
  metricName: string;
  /** Latest prompt description from prompt registry for this judge, if available. */
  description?: string | null;
  artifactsEvaluated: number;
  min: number;
  mean: number;
  max: number;
  stdDev: number;
  /** Minimum normalized (0-1) human star rating across the artifacts this judge evaluated. null when no human ratings exist. */
  humanMin: number | null;
  /** Maximum normalized (0-1) human star rating across the artifacts this judge evaluated. null when no human ratings exist. */
  humanMax: number | null;
  /** Mean normalized (0-1) human star rating across the artifacts this judge evaluated. null when no human ratings exist. */
  humanMean: number | null;
  /** Standard deviation of normalized (0-1) human star ratings across the artifacts this judge evaluated. null when no human ratings exist. */
  humanStdDev: number | null;
};

/**
 * Group of judge statistics for a single artifact type.
 *
 * Attributes:
 * - artifactType: The artifact type (e.g., PRD, IMPLEMENTATION_PLAN)
 * - judges: Array of aggregate statistics per judge, sorted descending by mean score
 * - humanRatingsCount: Number of human ratings (ArtifactRating) created in the same date range for artifacts of this type in the org
 * - humanCommentsCount: Number of artifact ratings with a non-empty comment (artifact_ratings.comment) in the same date range for artifacts of this type in the org
 */
export type ArtifactTypeGroup = {
  artifactType: ArtifactType;
  judges: JudgeAggregateStats[];
  humanRatingsCount: number;
  humanCommentsCount: number;
};

/**
 * Top-level response structure for the judges analytics endpoint.
 *
 * Attributes:
 * - groups: Array of artifact type groups, each containing judge statistics
 */
export type JudgeStatsResponse = {
  reportType: EvaluationReportType;
  groups: ArtifactTypeGroup[];
};

// ---------------------------------------------------------------------------
// Artifact creation counts (GET /judges-analytics/artifact-counts)
// ---------------------------------------------------------------------------

/**
 * Single time bucket for artifact creation counts.
 *
 * Attributes:
 * - bucket: ISO date string for the start of the period (e.g. "2025-02-01" for day,
 *   or start of week/month). Frontend can format with date-fns by groupBy.
 * - countsByType: Map of artifact type (ArtifactType value, e.g. "PRD", "IMPLEMENTATION_PLAN")
 *   to count of artifacts created in that period. Only types with count > 0 are included.
 */
export type ArtifactCountBucket = {
  bucket: string;
  countsByType: Record<string, number>;
};

/**
 * Response for the artifact counts endpoint.
 *
 * Attributes:
 * - buckets: Array of time buckets with counts, ordered by bucket ascending
 */
export type ArtifactCountsResponse = {
  buckets: ArtifactCountBucket[];
};

/**
 * Allowed values for grouping artifact counts by time period.
 */
export const ARTIFACT_COUNTS_GROUP_BY_OPTIONS = [
  "day",
  "week",
  "month",
] as const;

export type ArtifactCountsGroupBy =
  (typeof ARTIFACT_COUNTS_GROUP_BY_OPTIONS)[number];

// ---------------------------------------------------------------------------
// Judge detail page types (GET /judges-analytics/:promptName)
// ---------------------------------------------------------------------------

/**
 * Score statistics for a single prompt version.
 */
export type JudgePromptVersion = {
  promptId: string;
  version: number;
  scoreCount: number;
  mean: number;
  stdDev: number;
  min: number;
  max: number;
  createdAt: string; // ISO date string
  radarAxes: RadarAxes | null; // null when scoreCount < minScoreCount
};

/**
 * Normalized radar-chart axes describing a judge's behavioral characteristics.
 * All values are in [0, 1].
 */
export type RadarAxes = {
  stubbornness: number; // high = very consistent/stubborn
  optimism: number; // high = optimistic, low = critical
  polarity: number; // high = polarizing
  certainty: number; // high = decisive
};

export type CharacteristicLabel =
  | "Stubborn"
  | "Open-Minded"
  | "Optimistic"
  | "Critical"
  | "Polarizing"
  | "Decisive"
  | "Uncertain";

/**
 * Full detail payload for a single judge, keyed by normalized prompt name.
 */
export type JudgeDetail = {
  reportType: EvaluationReportType;
  promptName: string; // normalized, stable cross-version key
  displayName: string; // raw prompt name for display
  latestPromptId: string | null;
  scoreCount: number;
  radarAxes: RadarAxes | null; // null when scoreCount < minScoreCount
  labels: CharacteristicLabel[];
  promptText: string | null; // from latest prompt row
  promptVersions: JudgePromptVersion[];
  unknownVersionScoreCount: number; // prompt_id IS NULL rows count
};

export type JudgeDetailResponse = {
  judge: JudgeDetail;
};

// ---------------------------------------------------------------------------
// Score comparison types (GET /judges-analytics/:promptName/scores)
// ---------------------------------------------------------------------------

/**
 * A single row in the score comparison table showing judge vs human rating.
 *
 * Concurrence default: when userRatingCount = 0, avgUserRating = judgeScore and delta = 0.
 */
export type JudgeScoreRow = {
  /** Unique ID of the JudgeScore row; use for React keys when artifactId can repeat. */
  judgeScoreId: string;
  /** Metric name for this score row. Used for display and filtering. */
  metricName: string;
  artifactId: string;
  artifactType: ArtifactType;
  artifactTitle: string;
  artifactSlug: string;
  judgeScore: number;
  /** Average human rating (0-1). Defaults to judgeScore when no human ratings. */
  avgUserRating: number;
  /** Number of human ratings for this judge score. */
  userRatingCount: number;
  /** |avgUserRating - judgeScore|. 0 when no human ratings. */
  delta: number;
  /** ISO date string of when the evaluation was created. */
  evaluatedAt: string;
};

/**
 * Pagination metadata for score comparison results.
 */
export type ScorePaginationMeta = {
  page: number;
  pageSize: number;
  totalRows: number;
  totalPages: number;
};

/**
 * Response for the score comparison endpoint.
 */
export type JudgeScoresResponse = {
  rows: JudgeScoreRow[];
  totalArtifacts: number;
  ratedArtifacts: number;
  /** Percentage of artifacts with at least one human rating. */
  coveragePct: number;
  pagination: ScorePaginationMeta;
};

// ---------------------------------------------------------------------------
// Judge rating submission types (POST /artifacts/:artifactId/judge-ratings)
// ---------------------------------------------------------------------------

/**
 * Request body for submitting a human rating on a specific judge score.
 */
export type SubmitJudgeRatingRequest = {
  judgeScoreId: string;
  rating: number;
};

/**
 * Response after submitting or updating a judge rating.
 */
export type SubmitJudgeRatingResponse = {
  rating: number;
  isUpdate: boolean;
  /** URL-safe normalized prompt name for targeted cache invalidation. Null when judge score has no linked prompt. */
  promptName?: string | null;
  /** URL-safe normalized metric name for targeted cache invalidation. Null when judge score has no metric name. */
  metricName?: string | null;
  /** Evaluation report type for targeted cache invalidation. */
  reportType?: EvaluationReportType | null;
};

// ---------------------------------------------------------------------------
// User judge ratings types (GET /artifacts/:artifactId/judge-ratings)
// ---------------------------------------------------------------------------

/**
 * A single user rating for a judge score.
 */
export type UserJudgeRating = {
  judgeScoreId: string;
  rating: number;
};

/**
 * Response containing all of the current user's ratings for judge scores on an artifact.
 */
export type UserJudgeRatingsResponse = {
  ratings: UserJudgeRating[];
};
