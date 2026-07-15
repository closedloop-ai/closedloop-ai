/**
 * PostHog feature-flag keys for the Artifacts section. Each artifact is gated
 * individually, so nav items, page routes, and E2E route fixtures can share the
 * same canonical key set without duplicating string literals.
 */
export const ArtifactFlag = {
  Documents: "documents-nav",
  Issues: "issues-nav",
  Branches: "branches-nav",
  BranchDetail: "branch-detail-page",
} as const;
export type ArtifactFlagMap = typeof ArtifactFlag;
export type ArtifactFlag = (typeof ArtifactFlag)[keyof typeof ArtifactFlag];
