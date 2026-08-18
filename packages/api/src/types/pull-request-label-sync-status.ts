/**
 * ISS-4664 / ISS-4764: the outcome of a PR-label propagation pass.
 *
 * Deliberately a lightweight, dependency-free module. The status is read by
 * `@repo/github` (server), `apps/api` (server) AND the shared web/desktop
 * link-PR dialog (a `"use client"` component). Co-locating it with the
 * Zod-carrying mapper in `./pull-request-label.ts` would drag Zod into the
 * browser bundle for the sake of four string constants, which is exactly the
 * split this repo asks for.
 */

export const PullRequestLabelSyncStatus = {
  /** At least one label was added to the pull request. */
  Applied: "applied",
  /** Nothing to do — the PR already carried every tag-derived label. */
  NoOp: "no_op",
  /** GitHub rejected the read or the write; labels are unchanged. */
  Failed: "failed",
  /**
   * ISS-4759: the requested tag source did not validate as a legitimate
   * same-project implementing DOCUMENT, so NO GitHub call was made. Distinct
   * from `Failed` on purpose — `Failed` is a retriable provider problem, this
   * is a rejected caller input that will never succeed on retry.
   */
  SourceRejected: "source_rejected",
} as const;
export type PullRequestLabelSyncStatus =
  (typeof PullRequestLabelSyncStatus)[keyof typeof PullRequestLabelSyncStatus];

export type PullRequestLabelSyncResult = {
  status: PullRequestLabelSyncStatus;
  /** Labels this pass created in the repository. */
  createdLabels: string[];
  /** Labels this pass added to the pull request. */
  addedLabels: string[];
  /**
   * ISS-4762: labels the ceiling refused to apply. Non-empty means the pass
   * deliberately did NOT converge, and says exactly which tags were left off —
   * the alternative (a silent truncation reported as success) is the failure
   * mode this field exists to prevent. Always present so a consumer never has
   * to distinguish "no drops" from "an older producer that never reported".
   */
  droppedLabels: string[];
};

/** An empty result carrying `status`, for the many early-return paths. */
export function emptyPullRequestLabelSyncResult(
  status: PullRequestLabelSyncStatus
): PullRequestLabelSyncResult {
  return { status, createdLabels: [], addedLabels: [], droppedLabels: [] };
}
