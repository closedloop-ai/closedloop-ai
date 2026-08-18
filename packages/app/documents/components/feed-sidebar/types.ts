export const FeedArtifactType = {
  Prd: "PRD",
  Plan: "PLAN",
  Feature: "FEATURE",
  Branch: "BRANCH",
  // Org-level generic Document (DOC, ISS-4382). Distinct member so the feed
  // rail's per-artifact-type width preference and source filtering are scoped
  // to documents and never share the PRD's persisted layout key.
  Doc: "DOC",
} as const;
export type FeedArtifactType =
  (typeof FeedArtifactType)[keyof typeof FeedArtifactType];
