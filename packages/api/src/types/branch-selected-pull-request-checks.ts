import type { ChecksStatus } from "./branch-checks.ts";
import { ChecksStatus as ChecksStatusValue } from "./branch-checks.ts";
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

/** Legacy Branch fields consumed by clients that predate detailed checks evidence. */
export type BranchSelectedPullRequestChecksLegacyFields = {
  checksStatus: ChecksStatus | null;
  checksPassed: number | null;
  checksTotal: number | null;
};

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

/** One response plus the legacy fields derived from the same evidence. */
export type BranchSelectedPullRequestChecksProjection = {
  response: BranchSelectedPullRequestChecksResponse;
  legacy: BranchSelectedPullRequestChecksLegacyFields;
};

/** Project normalized provider evidence without upgrading partial coverage. */
export function projectBranchSelectedPullRequestChecks(
  evidence: SelectedPullRequestChecksEvidence
): BranchSelectedPullRequestChecksProjection {
  const summary = summaryFor(evidence);
  return {
    response: {
      status: BranchSelectedPullRequestChecksAvailability.Available,
      value: { ...evidence, summary },
    },
    legacy: legacyFieldsFor(evidence, summary),
  };
}

/** Preserve an access denial while withholding every unsupported legacy count. */
export function branchSelectedPullRequestChecksAccessUnavailable(
  reason: GitHubAccessDenialReason,
  retryAfterSeconds?: number | null
): BranchSelectedPullRequestChecksProjection {
  return {
    response: {
      status: BranchSelectedPullRequestChecksAvailability.Unavailable,
      source: BranchSelectedPullRequestChecksUnavailableSource.Access,
      reason,
      ...(retryAfterSeconds === undefined ? {} : { retryAfterSeconds }),
    },
    legacy: unavailableLegacyFields(),
  };
}

/** Preserve a landed provider failure while withholding unsupported legacy counts. */
export function branchSelectedPullRequestChecksEvidenceUnavailable(
  result: Extract<
    SelectedPullRequestChecksEvidenceResult,
    { status: typeof SelectedPullRequestEvidenceAvailability.Unavailable }
  >
): BranchSelectedPullRequestChecksProjection {
  return {
    response: {
      status: BranchSelectedPullRequestChecksAvailability.Unavailable,
      source: BranchSelectedPullRequestChecksUnavailableSource.Evidence,
      reason: result.reason,
      ...(result.retryAfterSeconds === undefined
        ? {}
        : { retryAfterSeconds: result.retryAfterSeconds }),
    },
    legacy: unavailableLegacyFields(),
  };
}

/** Clear persisted compatibility scalars before optional enrichment runs. */
export function unavailableBranchSelectedPullRequestChecksLegacyFields(): BranchSelectedPullRequestChecksLegacyFields {
  return unavailableLegacyFields();
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

function legacyFieldsFor(
  evidence: SelectedPullRequestChecksEvidence,
  summary: BranchSelectedPullRequestChecksSummary
): BranchSelectedPullRequestChecksLegacyFields {
  if (
    evidence.coverage.completeness !==
    SelectedPullRequestChecksCompleteness.Complete
  ) {
    return unavailableLegacyFields();
  }
  const checksStatus = legacyStatusFor(summary);
  if (checksStatus === null) {
    return unavailableLegacyFields();
  }
  return {
    checksStatus,
    checksPassed: evidence.counts.successful,
    checksTotal: evidence.counts.total,
  };
}

function legacyStatusFor(
  summary: BranchSelectedPullRequestChecksSummary
): ChecksStatus | null {
  switch (summary) {
    case BranchSelectedPullRequestChecksSummary.Failing:
      return ChecksStatusValue.Failing;
    case BranchSelectedPullRequestChecksSummary.Pending:
      return ChecksStatusValue.Pending;
    case BranchSelectedPullRequestChecksSummary.Successful:
      return ChecksStatusValue.Passing;
    case BranchSelectedPullRequestChecksSummary.NotApplicable:
    case BranchSelectedPullRequestChecksSummary.Partial:
      return null;
    default:
      return assertNever(summary);
  }
}

function unavailableLegacyFields(): BranchSelectedPullRequestChecksLegacyFields {
  return {
    checksStatus: null,
    checksPassed: null,
    checksTotal: null,
  };
}

function assertNever(value: never): never {
  throw new Error(`Unhandled selected-PR checks summary: ${value}`);
}
