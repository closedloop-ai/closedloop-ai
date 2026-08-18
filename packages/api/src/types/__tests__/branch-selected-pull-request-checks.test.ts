import { describe, expect, it } from "vitest";
import { ChecksStatus } from "../branch-checks";
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
      checksStatus: ChecksStatus.Failing,
    },
    {
      counts: { successful: 2, failing: 0, pending: 1, neutral: 0 },
      summary: BranchSelectedPullRequestChecksSummary.Pending,
      checksStatus: ChecksStatus.Pending,
    },
    {
      counts: { successful: 3, failing: 0, pending: 0, neutral: 0 },
      summary: BranchSelectedPullRequestChecksSummary.Successful,
      checksStatus: ChecksStatus.Passing,
    },
  ])("derives complete actionable $summary evidence and compatible scalars", ({
    counts,
    summary,
    checksStatus,
  }) => {
    const evidenceValue = evidence({ counts });
    const projection = projectBranchSelectedPullRequestChecks(evidenceValue);

    expect(projection).toEqual({
      response: {
        status: BranchSelectedPullRequestChecksAvailability.Available,
        value: { ...evidenceValue, summary },
      },
      legacy: {
        checksStatus,
        checksPassed: counts.successful,
        checksTotal:
          counts.successful + counts.failing + counts.pending + counts.neutral,
      },
    });
  });

  it("maps complete neutral-only and known-empty evidence to N/A without legacy counts", () => {
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
    expect(neutral.legacy).toEqual(nullLegacy());
    expect(empty.legacy).toEqual(nullLegacy());
  });

  it("preserves partial rows and counts while clearing unqualified legacy scalars", () => {
    const evidenceValue = evidence({
      counts: { successful: 5, failing: 0, pending: 0, neutral: 0 },
      completeness: SelectedPullRequestChecksCompleteness.Partial,
    });
    const projection = projectBranchSelectedPullRequestChecks(evidenceValue);

    expect(projection.legacy).toEqual(nullLegacy());
    expect(projection.response).toEqual({
      status: BranchSelectedPullRequestChecksAvailability.Available,
      value: {
        ...evidenceValue,
        summary: BranchSelectedPullRequestChecksSummary.Partial,
      },
    });
  });

  it("preserves typed access and evidence failures without legacy values", () => {
    expect(
      branchSelectedPullRequestChecksAccessUnavailable(
        GitHubAccessDenialReason.RateLimited,
        30
      )
    ).toEqual({
      response: {
        status: BranchSelectedPullRequestChecksAvailability.Unavailable,
        source: BranchSelectedPullRequestChecksUnavailableSource.Access,
        reason: GitHubAccessDenialReason.RateLimited,
        retryAfterSeconds: 30,
      },
      legacy: nullLegacy(),
    });
    expect(
      branchSelectedPullRequestChecksEvidenceUnavailable({
        status: SelectedPullRequestEvidenceAvailability.Unavailable,
        reason: SelectedPullRequestEvidenceUnavailableReason.ProviderTimedOut,
      })
    ).toEqual({
      response: {
        status: BranchSelectedPullRequestChecksAvailability.Unavailable,
        source: BranchSelectedPullRequestChecksUnavailableSource.Evidence,
        reason: SelectedPullRequestEvidenceUnavailableReason.ProviderTimedOut,
      },
      legacy: nullLegacy(),
    });
  });
});

function availableSummary(
  projection: ReturnType<typeof projectBranchSelectedPullRequestChecks>
) {
  if (
    projection.response.status !==
    BranchSelectedPullRequestChecksAvailability.Available
  ) {
    throw new Error("Expected available selected-PR checks");
  }
  return projection.response.value.summary;
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
      repositoryFullName: "closedloop-ai/symphony-alpha",
      number: 4394,
      url: "https://github.com/closedloop-ai/symphony-alpha/pull/4394",
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

function nullLegacy() {
  return {
    checksStatus: null,
    checksPassed: null,
    checksTotal: null,
  };
}
