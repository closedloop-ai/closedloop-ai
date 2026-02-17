// Judges Analytics API types for aggregate statistics and reporting.
// These types are shared between the backend API and frontend query hooks.
//
// The judges analytics endpoint returns aggregate statistics for LLM judge evaluations
// grouped by artifact type and judge name.

import type { ArtifactType } from "./artifact";

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
  artifactsEvaluated: number;
  min: number;
  mean: number;
  max: number;
  stdDev: number;
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
