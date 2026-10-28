export const ReconcileRepoStatus = {
  Swept: "swept",
  Deferred: "deferred",
  Reclassified: "reclassified",
  Failed: "failed",
} as const;
export type ReconcileRepoStatus =
  (typeof ReconcileRepoStatus)[keyof typeof ReconcileRepoStatus];
