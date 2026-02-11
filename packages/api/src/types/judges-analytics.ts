// Judges Analytics API types for aggregate statistics and reporting.
// These types are shared between the backend API and frontend query hooks.
//
// The judges analytics endpoint returns aggregate statistics for LLM judge evaluations
// grouped by artifact subtype and judge name.

import type { ArtifactSubtype } from "./artifact";

/**
 * Aggregate statistics for a single judge within an artifact subtype group.
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
 * Group of judge statistics for a single artifact subtype.
 *
 * Attributes:
 * - artifactSubtype: The artifact subtype (e.g., PRD, IMPLEMENTATION_PLAN)
 * - judges: Array of aggregate statistics per judge, sorted descending by mean score
 */
export type ArtifactSubtypeGroup = {
  artifactSubtype: ArtifactSubtype;
  judges: JudgeAggregateStats[];
};

/**
 * Top-level response structure for the judges analytics endpoint.
 *
 * Attributes:
 * - groups: Array of artifact subtype groups, each containing judge statistics
 */
export type JudgeStatsResponse = {
  groups: ArtifactSubtypeGroup[];
};
