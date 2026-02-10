// Rating types for API contract
// These are explicitly defined to keep packages/api independent of database

/**
 * Request body for submitting or updating an artifact rating (PUT).
 * Score is required; comment is optional to support rating-only submissions.
 */
export type SubmitRatingRequest = {
  score: number;
  comment?: string;
};

/**
 * Individual rating representation.
 * Used in responses for both GET and PUT endpoints.
 */
export type ArtifactRatingResponse = {
  id: string;
  userId: string;
  score: number;
  comment?: string;
  artifactVersion: number;
  createdAt: Date;
  updatedAt: Date;
};

/**
 * Aggregate rating summary combining user's rating with overall statistics.
 * Returned by both GET (fetch summary) and PUT (after upsert) endpoints.
 * userRating is nullable to support "no rating yet" state.
 */
export type ArtifactRatingSummary = {
  average: number;
  count: number;
  userRating: ArtifactRatingResponse | null;
};
