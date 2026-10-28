import { BranchStatus } from "@repo/api/src/types/branch";
import {
  BranchAssociatedPullRequestCompletenessState,
  BranchAssociatedPullRequestProvenance,
  BranchAssociatedPullRequestSelectionReason,
} from "@repo/api/src/types/branch-associated-pull-request";
import { ReviewDecision } from "@repo/api/src/types/branch-checks";
import { projectBranchSelectedPullRequestChecks } from "@repo/api/src/types/branch-selected-pull-request-checks";
import { GitHubPRState } from "@repo/api/src/types/github-status";
import {
  SelectedPullRequestCheckCategory,
  SelectedPullRequestCheckSourceKind,
  SelectedPullRequestChecksCompleteness,
  SelectedPullRequestChecksHistoryMode,
} from "@repo/api/src/types/selected-pull-request-checks-evidence";
import { render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../../../../shared/api/api-error";
import { createWrapper } from "../../../../shared/test-utils";
import { makeBranchDetail } from "../../../__tests__/branch-fixtures";
import { BranchPrStatusPanel } from "../branch-pr-status-panel";

const mocks = vi.hoisted(() => ({ apiGet: vi.fn() }));

vi.mock("../../../../shared/api/use-api-client", () => ({
  useApiClient: () => ({ get: mocks.apiGet }),
}));

const BRANCH_ID = "11111111-1111-4111-8111-111111111111";
const HEAD_SHA = "b".repeat(40);
const UNAVAILABLE_CHECKS_VALUE = "Unavailable";
const PASSED_ONLY_COUNTS_RE = /Passed 1 · Failed 0/;

describe("BranchPrStatusPanel lazy checks (ISS-12278)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("requests checks pinned to the rendered head and shows a skeleton while they load", () => {
    mocks.apiGet.mockReturnValue(new Promise(() => undefined));

    const { container } = renderPanel();

    expect(mocks.apiGet).toHaveBeenCalledWith(
      `/branches/${BRANCH_ID}/selected-pull-request/checks?repositoryFullName=octo%2Frepo&pullRequestNumber=42&headSha=${HEAD_SHA}`,
      expect.objectContaining({ signal: expect.any(AbortSignal) })
    );
    expect(
      container.querySelector('[data-slot="skeleton"]')
    ).toBeInTheDocument();
    expect(
      screen.queryByText(UNAVAILABLE_CHECKS_VALUE)
    ).not.toBeInTheDocument();
  });

  it("renders the fetched checks result", async () => {
    mocks.apiGet.mockResolvedValue(
      projectBranchSelectedPullRequestChecks(checksEvidence())
    );

    const { container } = renderPanel();

    expect(await screen.findByText(PASSED_ONLY_COUNTS_RE)).toBeInTheDocument();
    expect(
      container.querySelector('[data-slot="skeleton"]')
    ).not.toBeInTheDocument();
  });

  it("falls to Unavailable when the checks read fails", async () => {
    mocks.apiGet.mockRejectedValue(new ApiError("Failed", 500));

    renderPanel();

    await waitFor(() =>
      expect(screen.getByText(UNAVAILABLE_CHECKS_VALUE)).toBeInTheDocument()
    );
  });

  it("renders inline checks without a request when the detail carries them", () => {
    renderPanel({
      selectedPullRequestChecks: projectBranchSelectedPullRequestChecks(
        checksEvidence()
      ),
    });

    expect(screen.getByText(PASSED_ONLY_COUNTS_RE)).toBeInTheDocument();
    expect(mocks.apiGet).not.toHaveBeenCalled();
  });
});

function renderPanel(overrides = {}) {
  return render(<BranchPrStatusPanel detail={lazyDetail(overrides)} />, {
    wrapper: createWrapper(),
  });
}

function lazyDetail(overrides = {}) {
  const selected = {
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
  };
  return makeBranchDetail({
    id: BRANCH_ID,
    status: BranchStatus.Open,
    associatedPullRequests: {
      items: [selected],
      selectedId: selected.id,
      selectionReason: BranchAssociatedPullRequestSelectionReason.Active,
      completeness: {
        state: BranchAssociatedPullRequestCompletenessState.Complete,
        reasons: [],
        provenance: BranchAssociatedPullRequestProvenance.PersistedCloud,
      },
    },
    selectedPullRequest: {
      ...selected,
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

function checksEvidence() {
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
      providerExpected: 1,
      providerReturned: 1,
      normalizedAttempts: 1,
      emitted: 1,
      total: 1,
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
      completeness: SelectedPullRequestChecksCompleteness.Complete,
      reasons: [],
    },
  };
}
