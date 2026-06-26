export const FeedArtifactType = {
  Prd: "PRD",
  Plan: "PLAN",
  Feature: "FEATURE",
  Branch: "BRANCH",
} as const;
export type FeedArtifactType =
  (typeof FeedArtifactType)[keyof typeof FeedArtifactType];
