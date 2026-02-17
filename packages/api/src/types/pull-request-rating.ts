// Pull request rating types for API contract
// These are explicitly defined to keep packages/api independent of database

/**
 * Request body for submitting or updating a pull request rating (PUT).
 * Score is required; comment is optional to support rating-only submissions.
 */
export type SubmitPullRequestRatingRequest = {
  score: number;
  comment?: string;
};

/**
 * Individual pull request rating representation.
 * Used in responses for both GET and PUT endpoints.
 * Note: Unlike ArtifactRating, pull request ratings do not include artifactVersion
 * since they are tied to GitHub pull request IDs, not Symphony artifact versions.
 */
export type PullRequestRatingResponse = {
  id: string;
  userId: string;
  score: number;
  comment?: string;
  createdAt: Date;
  updatedAt: Date;
};

/**
 * Aggregate pull request rating summary combining user's rating with overall statistics.
 * Returned by both GET (fetch summary) and PUT (after upsert) endpoints.
 * userRating is nullable to support "no rating yet" state.
 * Statistics are extracted from Prisma aggregate (_avg.score and _count).
 */
export type PullRequestRatingSummary = {
  userRating: PullRequestRatingResponse | null;
  average: number;
  count: number;
};
