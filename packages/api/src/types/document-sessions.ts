import type { BranchPageDetail } from "./branch.ts";
import type { BranchTraceResult } from "./branch-trace.ts";

/** The shared Sessions timeline input, without a requirement for a branch or PR. */
export type SessionTimelineDetail = Pick<
  BranchPageDetail,
  "id" | "sessions" | "mergedTrace" | "estimatedCostUsd" | "attributedCostUsd"
> &
  Partial<
    Pick<
      BranchPageDetail,
      | "additions"
      | "deletions"
      | "commits"
      | "mergedAt"
      | "openedAt"
      | "prNumber"
      | "associatedPullRequests"
    >
  >;

/** Complete document-related population and its shared, interleaved session trace. */
export type DocumentSessionsResponse = {
  detail: SessionTimelineDetail;
  trace: BranchTraceResult;
};
