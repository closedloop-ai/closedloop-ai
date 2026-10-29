import { BranchStatus } from "@repo/api/src/types/branch";
import { ReviewDecision } from "@repo/api/src/types/branch-checks";
import {
  branchSelectedPullRequestChecksEvidenceUnavailable,
  projectBranchSelectedPullRequestChecks,
} from "@repo/api/src/types/branch-selected-pull-request-checks";
import { GitHubPRState } from "@repo/api/src/types/github-status";
import {
  SelectedPullRequestCheckCategory,
  SelectedPullRequestCheckSourceKind,
  SelectedPullRequestChecksCompleteness,
  SelectedPullRequestChecksHistoryMode,
  SelectedPullRequestChecksPartialReason,
} from "@repo/api/src/types/selected-pull-request-checks-evidence";
import {
  SelectedPullRequestEvidenceAvailability,
  SelectedPullRequestEvidenceUnavailableReason,
} from "@repo/api/src/types/selected-pull-request-evidence";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { makeBranchDetail } from "../../../__tests__/branch-fixtures";
import { deriveLifecycleBadge } from "../../../lib/merge-status-derivation";
import { BranchPrStatusPanel } from "../branch-pr-status-panel";

const HEAD_SHA = "b".repeat(40);
const INCOMPLETE_CHECKS_BUTTON_RE = /checks\s*1\/2 observed\*/i;
const ALL_ACTIONABLE_STATUS_COUNTS_RE =
  /Passed 1 · Failed 1 · Pending 1 · Skipped 1 · Canceled 1/;
const NEUTRAL_RE = /Neutral/;
const NEUTRAL_REMAINDER_RE =
  /Passed 1 · Failed 0 · Pending 0 · Skipped 1 · Canceled 1 · Neutral 1/;
const PARTIAL_PROVIDER_COUNTS_RE = /1 of 2 provider checks returned/i;
const UNAVAILABLE_CHECKS_VALUE = "Unavailable";

describe("BranchPrStatusPanel", () => {
  it("renders nothing when the producer resolved no selected pull request", () => {
    render(
      <BranchPrStatusPanel
        detail={makeBranchDetail({ selectedPullRequest: null })}
      />
    );
    expect(screen.queryByText("Checks & review")).not.toBeInTheDocument();
  });

  it("renders selected-PR lifecycle, review decision, and every actionable status count", () => {
    render(
      <BranchPrStatusPanel
        detail={selectedDetail({
          selectedPullRequestChecks: projectBranchSelectedPullRequestChecks({
            ...checksEvidence(false),
            checks: [
              makeCheck("passed", SelectedPullRequestCheckCategory.Successful),
              makeCheck("failed", SelectedPullRequestCheckCategory.Failing),
              makeCheck("pending", SelectedPullRequestCheckCategory.Pending),
              makeCheck(
                "skipped",
                SelectedPullRequestCheckCategory.Neutral,
                "skipped"
              ),
              makeCheck(
                "canceled",
                SelectedPullRequestCheckCategory.Neutral,
                "cancelled"
              ),
            ],
            counts: {
              providerExpected: 5,
              providerReturned: 5,
              normalizedAttempts: 5,
              emitted: 5,
              total: 5,
              successful: 1,
              failing: 1,
              pending: 1,
              neutral: 2,
            },
          }),
        })}
      />
    );

    expect(screen.getByText("Checks & review")).toBeInTheDocument();
    expect(screen.getByText("Approved")).toBeInTheDocument();
    expect(screen.getByText("1 failing")).toBeInTheDocument();
    expect(
      screen.getByText(ALL_ACTIONABLE_STATUS_COUNTS_RE)
    ).toBeInTheDocument();
    expect(screen.queryByText(NEUTRAL_RE)).not.toBeInTheDocument();
  });

  it("shows a neutral remainder only when it is not skipped or canceled", () => {
    render(
      <BranchPrStatusPanel
        detail={selectedDetail({
          selectedPullRequestChecks: projectBranchSelectedPullRequestChecks({
            ...checksEvidence(false),
            checks: [
              makeCheck("passed", SelectedPullRequestCheckCategory.Successful),
              makeCheck(
                "skipped",
                SelectedPullRequestCheckCategory.Neutral,
                "skipped"
              ),
              makeCheck(
                "canceled",
                SelectedPullRequestCheckCategory.Neutral,
                "canceled"
              ),
              makeCheck(
                "neutral",
                SelectedPullRequestCheckCategory.Neutral,
                "neutral"
              ),
            ],
            counts: {
              providerExpected: 4,
              providerReturned: 4,
              normalizedAttempts: 4,
              emitted: 4,
              total: 4,
              successful: 1,
              failing: 0,
              pending: 0,
              neutral: 3,
            },
          }),
        })}
      />
    );

    expect(screen.getByText(NEUTRAL_REMAINDER_RE)).toBeInTheDocument();
  });

  it("stars incomplete counts and discloses the incomplete coverage", () => {
    render(
      <BranchPrStatusPanel
        detail={selectedDetail({
          selectedPullRequestChecks: checksProjection(true),
        })}
      />
    );

    const disclosure = screen.getByRole("button", {
      name: INCOMPLETE_CHECKS_BUTTON_RE,
    });
    fireEvent.click(disclosure);
    expect(screen.getByText(PARTIAL_PROVIDER_COUNTS_RE)).toBeInTheDocument();
    expect(screen.getByText("Build")).toBeInTheDocument();
  });

  it("keeps unavailable checks distinct from a known empty check set", () => {
    const unavailable = branchSelectedPullRequestChecksEvidenceUnavailable({
      status: SelectedPullRequestEvidenceAvailability.Unavailable,
      reason: SelectedPullRequestEvidenceUnavailableReason.ProviderFailure,
    });
    const { rerender } = render(
      <BranchPrStatusPanel
        detail={selectedDetail({ selectedPullRequestChecks: unavailable })}
      />
    );
    expect(screen.getByText(UNAVAILABLE_CHECKS_VALUE)).toBeInTheDocument();

    rerender(
      <BranchPrStatusPanel
        detail={selectedDetail({
          selectedPullRequestChecks: projectBranchSelectedPullRequestChecks({
            ...checksEvidence(false),
            checks: [],
            counts: {
              providerExpected: 0,
              providerReturned: 0,
              normalizedAttempts: 0,
              emitted: 0,
              total: 0,
              successful: 0,
              failing: 0,
              pending: 0,
              neutral: 0,
            },
          }),
        })}
      />
    );
    expect(screen.getByText("N/A")).toBeInTheDocument();
    expect(
      screen.queryByText(UNAVAILABLE_CHECKS_VALUE)
    ).not.toBeInTheDocument();
  });

  // ISS-8422. This badge renders ONLY when a pull request is selected and is
  // presented as THAT pull request's lifecycle, so it may not print a confident
  // lifecycle word about one nobody observed. Two paths had to be closed: the
  // placeholder OPEN on `selected.state`, and `detail.status`, which
  // `persistedBadge` reads FIRST and which is never null — so the branch-level
  // word won and the Gated tone below was unreachable.
  it("says the status is unavailable for an unobserved selected PR, not Open", () => {
    render(
      <BranchPrStatusPanel
        detail={selectedDetail({
          status: BranchStatus.Open,
          selectedPullRequest: {
            ...selectedDetail().selectedPullRequest,
            lifecycleObserved: false,
            state: GitHubPRState.Open,
          },
        })}
      />
    );

    expect(screen.getByText("Status unavailable")).toBeInTheDocument();
    expect(
      screen.queryByText(
        deriveLifecycleBadge({
          persisted: { prState: null, status: BranchStatus.Open },
        }).label
      )
    ).not.toBeInTheDocument();
  });

  it("still reads the branch status for an OBSERVED selected PR", () => {
    // The counterfactual: nulling `status` unconditionally would have made every
    // branch's badge read "Status unavailable".
    render(<BranchPrStatusPanel detail={selectedDetail()} />);

    expect(screen.queryByText("Status unavailable")).not.toBeInTheDocument();
  });
});

function selectedDetail(overrides = {}) {
  return makeBranchDetail({
    status: BranchStatus.Open,
    selectedPullRequest: {
      id: "octo/repo#42",
      repositoryFullName: "octo/repo",
      number: 42,
      title: "Selected PR",
      url: "https://github.com/octo/repo/pull/42",
      state: GitHubPRState.Open,
      isDraft: false,
      reviewDecision: ReviewDecision.Approved,
      openedAt: "2026-08-01T00:00:00.000Z",
      closedAt: null,
      mergedAt: null,
      body: "Description",
      baseRefName: "main",
      authorLogin: "octocat",
      headRefOid: HEAD_SHA,
      mergeCommitSha: null,
      changedFiles: 1,
      additions: 5,
      deletions: 2,
    },
    ...overrides,
  });
}

function checksProjection(incomplete: boolean) {
  return projectBranchSelectedPullRequestChecks(checksEvidence(incomplete));
}

function checksEvidence(incomplete: boolean) {
  return {
    identity: {
      githubId: "PR_kwDOtest",
      repositoryFullName: "octo/repo",
      number: 42,
      url: "https://github.com/octo/repo/pull/42",
    },
    revision: { headSha: HEAD_SHA },
    checks: [
      {
        providerId: "check-1",
        sourceIdentity: "build",
        sourceKind: SelectedPullRequestCheckSourceKind.CheckRun,
        sourceApp: null,
        name: "Build",
        providerStatus: "completed",
        providerConclusion: "success",
        category: SelectedPullRequestCheckCategory.Successful,
        createdAt: null,
        startedAt: null,
        completedAt: null,
        targetUrl: null,
      },
    ],
    counts: {
      providerExpected: 2,
      providerReturned: 1,
      normalizedAttempts: 1,
      emitted: 1,
      total: 2,
      successful: 1,
      failing: 0,
      pending: 0,
      neutral: 0,
    },
    pagination: {
      pageSize: 100,
      pagesFetched: 1,
      acquisitionMaximum: 500,
      reachedAcquisitionMaximum: false,
    },
    history: {
      mode: SelectedPullRequestChecksHistoryMode.LatestPerSourceFromProviderRollup,
      providerLimit: null,
      rawAttempts: 1,
      emittedSources: 1,
    },
    coverage: {
      completeness: incomplete
        ? SelectedPullRequestChecksCompleteness.Partial
        : SelectedPullRequestChecksCompleteness.Complete,
      reasons: incomplete
        ? [SelectedPullRequestChecksPartialReason.CountMismatch]
        : [],
    },
  };
}

function makeCheck(
  sourceIdentity: string,
  category: SelectedPullRequestCheckCategory,
  providerConclusion = "success"
) {
  return {
    providerId: `check-${sourceIdentity}`,
    sourceIdentity,
    sourceKind: SelectedPullRequestCheckSourceKind.CheckRun,
    sourceApp: null,
    name: sourceIdentity,
    providerStatus: "completed",
    providerConclusion,
    category,
    createdAt: null,
    startedAt: null,
    completedAt: null,
    targetUrl: null,
  };
}
