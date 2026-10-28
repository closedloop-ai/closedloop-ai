import type { GitHubAccessDenialReason } from "./github.ts";
import {
  SelectedPullRequestChecksCompleteness,
  type SelectedPullRequestChecksEvidence,
  type SelectedPullRequestChecksEvidenceResult,
} from "./selected-pull-request-checks-evidence.ts";
import type {
  SelectedPullRequestEvidenceAvailability,
  SelectedPullRequestEvidenceUnavailableReason,
} from "./selected-pull-request-evidence.ts";

/** Availability of selected-PR checks in the Branch application response. */
export const BranchSelectedPullRequestChecksAvailability = {
  Available: "available",
  Unavailable: "unavailable",
} as const;
export type BranchSelectedPullRequestChecksAvailability =
  (typeof BranchSelectedPullRequestChecksAvailability)[keyof typeof BranchSelectedPullRequestChecksAvailability];

/** Truthful aggregate state derived from normalized selected-head checks. */
export const BranchSelectedPullRequestChecksSummary = {
  Failing: "failing",
  NotApplicable: "not_applicable",
  Partial: "partial",
  Pending: "pending",
  Successful: "successful",
} as const;
export type BranchSelectedPullRequestChecksSummary =
  (typeof BranchSelectedPullRequestChecksSummary)[keyof typeof BranchSelectedPullRequestChecksSummary];

/** Boundary that made selected-PR checks unavailable to the Branch response. */
export const BranchSelectedPullRequestChecksUnavailableSource = {
  Access: "access",
  Evidence: "evidence",
} as const;
export type BranchSelectedPullRequestChecksUnavailableSource =
  (typeof BranchSelectedPullRequestChecksUnavailableSource)[keyof typeof BranchSelectedPullRequestChecksUnavailableSource];

export type BranchSelectedPullRequestChecks =
  SelectedPullRequestChecksEvidence & {
    summary: BranchSelectedPullRequestChecksSummary;
  };

type AccessUnavailable = {
  status: typeof BranchSelectedPullRequestChecksAvailability.Unavailable;
  source: typeof BranchSelectedPullRequestChecksUnavailableSource.Access;
  reason: GitHubAccessDenialReason;
  retryAfterSeconds?: number | null;
};

type EvidenceUnavailable = {
  status: typeof BranchSelectedPullRequestChecksAvailability.Unavailable;
  source: typeof BranchSelectedPullRequestChecksUnavailableSource.Evidence;
  reason: SelectedPullRequestEvidenceUnavailableReason;
  retryAfterSeconds?: number | null;
};

/** Additive selected-PR checks value or a typed read failure. */
export type BranchSelectedPullRequestChecksResponse =
  | {
      status: typeof BranchSelectedPullRequestChecksAvailability.Available;
      value: BranchSelectedPullRequestChecks;
    }
  | AccessUnavailable
  | EvidenceUnavailable;

/**
 * Project normalized provider evidence without upgrading partial coverage.
 *
 * ISS-8241 Half A: this fold no longer also emits the Branch's
 * `checksStatus`/`checksPassed`/`checksTotal` scalars. Those are the SELECTED
 * pull request's own MEASURED rollup and come from the stored projection
 * (`projectSelectedPullRequestChecks`); a live acquisition overwriting them made
 * the Branch detail's measured value whatever GitHub happened to answer during
 * the request, which is a different question than the one those fields ask.
 */
export function projectBranchSelectedPullRequestChecks(
  evidence: SelectedPullRequestChecksEvidence
): BranchSelectedPullRequestChecksResponse {
  return {
    status: BranchSelectedPullRequestChecksAvailability.Available,
    value: { ...evidence, summary: summaryFor(evidence) },
  };
}

/** Preserve an access denial as its own typed unavailability. */
export function branchSelectedPullRequestChecksAccessUnavailable(
  reason: GitHubAccessDenialReason,
  retryAfterSeconds?: number | null
): BranchSelectedPullRequestChecksResponse {
  return {
    status: BranchSelectedPullRequestChecksAvailability.Unavailable,
    source: BranchSelectedPullRequestChecksUnavailableSource.Access,
    reason,
    ...(retryAfterSeconds === undefined ? {} : { retryAfterSeconds }),
  };
}

/** Preserve a landed provider failure as its own typed unavailability. */
export function branchSelectedPullRequestChecksEvidenceUnavailable(
  result: Extract<
    SelectedPullRequestChecksEvidenceResult,
    { status: typeof SelectedPullRequestEvidenceAvailability.Unavailable }
  >
): BranchSelectedPullRequestChecksResponse {
  return {
    status: BranchSelectedPullRequestChecksAvailability.Unavailable,
    source: BranchSelectedPullRequestChecksUnavailableSource.Evidence,
    reason: result.reason,
    ...(result.retryAfterSeconds === undefined
      ? {}
      : { retryAfterSeconds: result.retryAfterSeconds }),
  };
}

function summaryFor(
  evidence: SelectedPullRequestChecksEvidence
): BranchSelectedPullRequestChecksSummary {
  // Preserve observed rows/counts on partial evidence, including failures, but
  // do not advertise them as a conclusion about the incomplete population.
  if (
    evidence.coverage.completeness !==
    SelectedPullRequestChecksCompleteness.Complete
  ) {
    return BranchSelectedPullRequestChecksSummary.Partial;
  }
  if (evidence.counts.failing > 0) {
    return BranchSelectedPullRequestChecksSummary.Failing;
  }
  if (evidence.counts.pending > 0) {
    return BranchSelectedPullRequestChecksSummary.Pending;
  }
  if (evidence.counts.successful > 0) {
    return BranchSelectedPullRequestChecksSummary.Successful;
  }
  // A complete empty population and a neutral-only population both have no
  // actionable checks result, so DETAIL-004 classifies both as N/A.
  return BranchSelectedPullRequestChecksSummary.NotApplicable;
}
