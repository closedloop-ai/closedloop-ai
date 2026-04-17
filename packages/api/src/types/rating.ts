// Rating types for API contract
// These are explicitly defined to keep packages/api independent of database

/**
 * Request body for submitting or updating a document rating (PUT).
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
export type DocumentRatingResponse = {
  id: string;
  userId: string;
  score: number;
  comment?: string;
  documentVersion: number;
  createdAt: Date;
  updatedAt: Date;
};

/**
 * Aggregate rating summary combining user's rating with overall statistics.
 * Returned by both GET (fetch summary) and PUT (after upsert) endpoints.
 * userRating is nullable to support "no rating yet" state.
 */
export type DocumentRatingSummary = {
  average: number;
  count: number;
  userRating: DocumentRatingResponse | null;
};
