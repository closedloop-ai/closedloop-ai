import { describe, expect, it } from "vitest";
import {
  BranchSelectedPullRequestChecksAvailability,
  BranchSelectedPullRequestChecksSummary,
  BranchSelectedPullRequestChecksUnavailableSource,
  branchSelectedPullRequestChecksAccessUnavailable,
  branchSelectedPullRequestChecksEvidenceUnavailable,
  projectBranchSelectedPullRequestChecks,
} from "../branch-selected-pull-request-checks";
import { GitHubAccessDenialReason } from "../github";
import {
  SelectedPullRequestChecksCompleteness,
  type SelectedPullRequestChecksEvidence,
  SelectedPullRequestChecksHistoryMode,
  SelectedPullRequestChecksPartialReason,
} from "../selected-pull-request-checks-evidence";
import {
  SelectedPullRequestEvidenceAvailability,
  SelectedPullRequestEvidenceUnavailableReason,
} from "../selected-pull-request-evidence";

describe("projectBranchSelectedPullRequestChecks", () => {
  it.each([
    {
      counts: { successful: 2, failing: 1, pending: 1, neutral: 0 },
      summary: BranchSelectedPullRequestChecksSummary.Failing,
    },
    {
      counts: { successful: 2, failing: 0, pending: 1, neutral: 0 },
      summary: BranchSelectedPullRequestChecksSummary.Pending,
    },
    {
      counts: { successful: 3, failing: 0, pending: 0, neutral: 0 },
      summary: BranchSelectedPullRequestChecksSummary.Successful,
    },
  ])("derives complete actionable $summary evidence", ({ counts, summary }) => {
    const evidenceValue = evidence({ counts });

    // ISS-8241 Half A: the fold emits the evidence response and NOTHING else.
    // The Branch's checks scalars are the selected PR's own measured rollup and
    // are no longer derived from whatever this live acquisition returned.
    expect(projectBranchSelectedPullRequestChecks(evidenceValue)).toEqual({
      status: BranchSelectedPullRequestChecksAvailability.Available,
      value: { ...evidenceValue, summary },
    });
  });

  it("maps complete neutral-only and known-empty evidence to N/A", () => {
    const neutral = projectBranchSelectedPullRequestChecks(
      evidence({
        counts: { successful: 0, failing: 0, pending: 0, neutral: 2 },
      })
    );
    const empty = projectBranchSelectedPullRequestChecks(
      evidence({
        counts: { successful: 0, failing: 0, pending: 0, neutral: 0 },
      })
    );

    expect(availableSummary(neutral)).toBe(
      BranchSelectedPullRequestChecksSummary.NotApplicable
    );
    expect(availableSummary(empty)).toBe(
      BranchSelectedPullRequestChecksSummary.NotApplicable
    );
  });

  it("preserves partial rows and counts without upgrading coverage", () => {
    const evidenceValue = evidence({
      counts: { successful: 5, failing: 0, pending: 0, neutral: 0 },
      completeness: SelectedPullRequestChecksCompleteness.Partial,
    });
    expect(projectBranchSelectedPullRequestChecks(evidenceValue)).toEqual({
      status: BranchSelectedPullRequestChecksAvailability.Available,
      value: {
        ...evidenceValue,
        summary: BranchSelectedPullRequestChecksSummary.Partial,
      },
    });
  });

  it("preserves typed access and evidence failures", () => {
    expect(
      branchSelectedPullRequestChecksAccessUnavailable(
        GitHubAccessDenialReason.RateLimited,
        30
      )
    ).toEqual({
      status: BranchSelectedPullRequestChecksAvailability.Unavailable,
      source: BranchSelectedPullRequestChecksUnavailableSource.Access,
      reason: GitHubAccessDenialReason.RateLimited,
      retryAfterSeconds: 30,
    });
    expect(
      branchSelectedPullRequestChecksEvidenceUnavailable({
        status: SelectedPullRequestEvidenceAvailability.Unavailable,
        reason: SelectedPullRequestEvidenceUnavailableReason.ProviderTimedOut,
      })
    ).toEqual({
      status: BranchSelectedPullRequestChecksAvailability.Unavailable,
      source: BranchSelectedPullRequestChecksUnavailableSource.Evidence,
      reason: SelectedPullRequestEvidenceUnavailableReason.ProviderTimedOut,
    });
  });
});

function availableSummary(
  projection: ReturnType<typeof projectBranchSelectedPullRequestChecks>
) {
  if (
    projection.status !== BranchSelectedPullRequestChecksAvailability.Available
  ) {
    throw new Error("Expected available selected-PR checks");
  }
  return projection.value.summary;
}

function evidence(options: {
  counts: {
    successful: number;
    failing: number;
    pending: number;
    neutral: number;
  };
  completeness?: SelectedPullRequestChecksCompleteness;
}): SelectedPullRequestChecksEvidence {
  const total =
    options.counts.successful +
    options.counts.failing +
    options.counts.pending +
    options.counts.neutral;
  return {
    identity: {
      githubId: "123",
      repositoryFullName: "closedloop-ai/closedloop-ai",
      number: 4394,
      url: "https://github.com/closedloop-ai/closedloop-ai/pull/4394",
    },
    revision: { headSha: "a".repeat(40) },
    checks: [],
    counts: {
      providerExpected: total,
      providerReturned: total,
      normalizedAttempts: total,
      emitted: total,
      total,
      ...options.counts,
    },
    pagination: {
      pageSize: 100,
      pagesFetched: total === 0 ? 0 : 1,
      acquisitionMaximum: 3000,
      reachedAcquisitionMaximum: false,
    },
    history: {
      mode: SelectedPullRequestChecksHistoryMode.LatestPerSourceFromProviderRollup,
      providerLimit: null,
      rawAttempts: total,
      emittedSources: total,
    },
    coverage: {
      completeness:
        options.completeness ?? SelectedPullRequestChecksCompleteness.Complete,
      reasons:
        options.completeness === SelectedPullRequestChecksCompleteness.Partial
          ? [SelectedPullRequestChecksPartialReason.CountMismatch]
          : [],
    },
  };
}
