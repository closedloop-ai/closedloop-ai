import {
  type BranchPageDetail,
  BranchStatus,
} from "@repo/api/src/types/branch";
import {
  BranchAssociatedPullRequestCompletenessState,
  BranchAssociatedPullRequestProvenance,
  BranchAssociatedPullRequestSelectionReason,
} from "@repo/api/src/types/branch-associated-pull-request";
import {
  ChecksStatus,
  ReviewDecision,
} from "@repo/api/src/types/branch-checks";
import {
  BranchSelectedPullRequestChecksAvailability,
  BranchSelectedPullRequestChecksSummary,
  BranchSelectedPullRequestChecksUnavailableSource,
} from "@repo/api/src/types/branch-selected-pull-request-checks";
import {
  GitHubAccessDenialReason,
  GitHubPRState,
} from "@repo/api/src/types/github";
import {
  SelectedPullRequestChecksCompleteness,
  type SelectedPullRequestChecksEvidence,
  SelectedPullRequestChecksHistoryMode,
  SelectedPullRequestChecksPartialReason,
} from "@repo/api/src/types/selected-pull-request-checks-evidence";
import {
  SelectedPullRequestEvidenceAvailability,
  SelectedPullRequestEvidenceUnavailableReason,
} from "@repo/api/src/types/selected-pull-request-evidence";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  artifactFindFirst: vi.fn(),
  branchHasCloudEligibility: vi.fn(),
  getChecksEvidence: vi.fn(),
  runBranchViewRead: vi.fn(),
}));

vi.mock("@repo/database", () => ({
  ArtifactType: { BRANCH: "BRANCH" },
  withDb: (read: (db: unknown) => unknown) =>
    read({
      artifact: { findFirst: mocks.artifactFindFirst },
      $queryRaw: vi.fn(),
    }),
}));

vi.mock("@repo/github/selected-pull-request-checks-evidence", () => ({
  getSelectedPullRequestChecksEvidence: mocks.getChecksEvidence,
}));

vi.mock("@/lib/github/github-branch-view-read-client", () => ({
  runBranchViewRead: mocks.runBranchViewRead,
}));

vi.mock("./cloud-branch-eligibility", () => {
  return { branchHasCloudEligibility: mocks.branchHasCloudEligibility };
});

import { branchSelectedPullRequestChecksService } from "./branch-selected-pull-request-checks-service";

const BRANCH_ID = "11111111-1111-4111-8111-111111111111";
const ORGANIZATION_ID = "22222222-2222-4222-8222-222222222222";
const USER_ID = "33333333-3333-4333-8333-333333333333";
const REPOSITORY_FULL_NAME = "closedloop-ai/symphony-alpha";
const PULL_REQUEST_NUMBER = 4394;
const OCTOKIT = { marker: "octokit" };

describe("branchSelectedPullRequestChecksService.getChecks", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.artifactFindFirst.mockResolvedValue(branchRow());
    mocks.branchHasCloudEligibility.mockResolvedValue(true);
    mocks.getChecksEvidence.mockResolvedValue({
      status: SelectedPullRequestEvidenceAvailability.Available,
      value: checksEvidence(),
    });
    mocks.runBranchViewRead.mockImplementation(
      async (
        _input: unknown,
        read: (octokit: unknown) => Promise<unknown>
      ) => ({ ok: true, value: await read(OCTOKIT) })
    );
  });

  it("reads and projects the exact persisted selected PR through the requesting user", async () => {
    const controller = new AbortController();
    const result = await branchSelectedPullRequestChecksService.getChecks(
      ORGANIZATION_ID,
      USER_ID,
      BRANCH_ID,
      expectedSelection(),
      controller.signal
    );

    expect(mocks.artifactFindFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          id: BRANCH_ID,
          organizationId: ORGANIZATION_ID,
          type: "BRANCH",
          branch: { deletedAt: null },
        },
      })
    );
    expect(mocks.runBranchViewRead).toHaveBeenCalledWith(
      {
        organizationId: ORGANIZATION_ID,
        userId: USER_ID,
        target: { owner: "closedloop-ai", repo: "symphony-alpha" },
      },
      expect.any(Function)
    );
    expect(mocks.getChecksEvidence).toHaveBeenCalledWith(
      OCTOKIT,
      "closedloop-ai",
      "symphony-alpha",
      PULL_REQUEST_NUMBER,
      {
        signal: controller.signal,
        timeoutMs: 50_000,
      }
    );
    expect(result).toEqual(
      expect.objectContaining({
        response: expect.objectContaining({
          status: BranchSelectedPullRequestChecksAvailability.Available,
          value: expect.objectContaining({
            summary: BranchSelectedPullRequestChecksSummary.Successful,
          }),
        }),
        legacy: {
          checksStatus: ChecksStatus.Passing,
          checksPassed: 28,
          checksTotal: 28,
        },
      })
    );
  });

  it("does not read GitHub when the selected PR changed after the base detail read", async () => {
    const row = branchRow();
    const selected = row.pullRequestDetails[0];
    if (!selected) {
      throw new Error("Expected selected PR fixture");
    }
    row.pullRequestDetails[0] = {
      ...selected,
      number: PULL_REQUEST_NUMBER + 1,
      htmlUrl: `https://github.com/${REPOSITORY_FULL_NAME}/pull/${PULL_REQUEST_NUMBER + 1}`,
    };
    mocks.artifactFindFirst.mockResolvedValueOnce(row);

    await expect(
      branchSelectedPullRequestChecksService.getChecks(
        ORGANIZATION_ID,
        USER_ID,
        BRANCH_ID,
        expectedSelection()
      )
    ).resolves.toEqual({
      response: {
        status: BranchSelectedPullRequestChecksAvailability.Unavailable,
        source: BranchSelectedPullRequestChecksUnavailableSource.Evidence,
        reason: SelectedPullRequestEvidenceUnavailableReason.StaleRevision,
      },
      legacy: { checksStatus: null, checksPassed: null, checksTotal: null },
    });
    expect(mocks.runBranchViewRead).not.toHaveBeenCalled();
  });

  it("does not read GitHub when canonical Branch eligibility fails", async () => {
    mocks.branchHasCloudEligibility.mockResolvedValueOnce(false);

    await expect(
      branchSelectedPullRequestChecksService.getChecks(
        ORGANIZATION_ID,
        USER_ID,
        BRANCH_ID,
        expectedSelection()
      )
    ).resolves.toBeNull();
    expect(mocks.runBranchViewRead).not.toHaveBeenCalled();
    expect(mocks.getChecksEvidence).not.toHaveBeenCalled();
  });

  it("pins checks to persisted PR head when the Branch head differs", async () => {
    const row = branchRow();
    row.branch.headSha = "b".repeat(40);
    mocks.artifactFindFirst.mockResolvedValueOnce(row);

    const result = await branchSelectedPullRequestChecksService.getChecks(
      ORGANIZATION_ID,
      USER_ID,
      BRANCH_ID,
      expectedSelection()
    );
    expect(result?.response.status).toBe(
      BranchSelectedPullRequestChecksAvailability.Available
    );
    expect(mocks.runBranchViewRead).toHaveBeenCalledTimes(1);
  });

  it("preserves typed access and provider unavailability", async () => {
    mocks.runBranchViewRead.mockResolvedValueOnce({
      ok: false,
      error: {
        reason: GitHubAccessDenialReason.RateLimited,
        retryAfterSeconds: 20,
      },
    });
    await expect(
      branchSelectedPullRequestChecksService.getChecks(
        ORGANIZATION_ID,
        USER_ID,
        BRANCH_ID,
        expectedSelection()
      )
    ).resolves.toEqual({
      response: {
        status: BranchSelectedPullRequestChecksAvailability.Unavailable,
        source: BranchSelectedPullRequestChecksUnavailableSource.Access,
        reason: GitHubAccessDenialReason.RateLimited,
        retryAfterSeconds: 20,
      },
      legacy: { checksStatus: null, checksPassed: null, checksTotal: null },
    });

    mocks.getChecksEvidence.mockResolvedValueOnce({
      status: SelectedPullRequestEvidenceAvailability.Unavailable,
      reason: SelectedPullRequestEvidenceUnavailableReason.ProviderTimedOut,
    });
    await expect(
      branchSelectedPullRequestChecksService.getChecks(
        ORGANIZATION_ID,
        USER_ID,
        BRANCH_ID,
        expectedSelection()
      )
    ).resolves.toEqual({
      response: {
        status: BranchSelectedPullRequestChecksAvailability.Unavailable,
        source: BranchSelectedPullRequestChecksUnavailableSource.Evidence,
        reason: SelectedPullRequestEvidenceUnavailableReason.ProviderTimedOut,
      },
      legacy: { checksStatus: null, checksPassed: null, checksTotal: null },
    });
  });

  it("rejects provider evidence for a different PR as malformed", async () => {
    mocks.getChecksEvidence.mockResolvedValueOnce({
      status: SelectedPullRequestEvidenceAvailability.Available,
      value: checksEvidence({ number: PULL_REQUEST_NUMBER + 1 }),
    });

    const result = await branchSelectedPullRequestChecksService.getChecks(
      ORGANIZATION_ID,
      USER_ID,
      BRANCH_ID,
      expectedSelection()
    );

    expect(result).toEqual({
      response: {
        status: BranchSelectedPullRequestChecksAvailability.Unavailable,
        source: BranchSelectedPullRequestChecksUnavailableSource.Evidence,
        reason: SelectedPullRequestEvidenceUnavailableReason.MalformedResponse,
      },
      legacy: { checksStatus: null, checksPassed: null, checksTotal: null },
    });
  });

  it("classifies provider evidence for a changed selected head as stale", async () => {
    mocks.getChecksEvidence.mockResolvedValueOnce({
      status: SelectedPullRequestEvidenceAvailability.Available,
      value: checksEvidence({ headSha: "b".repeat(40) }),
    });

    const result = await branchSelectedPullRequestChecksService.getChecks(
      ORGANIZATION_ID,
      USER_ID,
      BRANCH_ID,
      expectedSelection()
    );

    expect(result).toEqual({
      response: {
        status: BranchSelectedPullRequestChecksAvailability.Unavailable,
        source: BranchSelectedPullRequestChecksUnavailableSource.Evidence,
        reason: SelectedPullRequestEvidenceUnavailableReason.StaleRevision,
      },
      legacy: { checksStatus: null, checksPassed: null, checksTotal: null },
    });
  });
});

describe("branchSelectedPullRequestChecksService.enrichBranchDetail", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.artifactFindFirst.mockResolvedValue(branchRow());
    mocks.branchHasCloudEligibility.mockResolvedValue(true);
    mocks.getChecksEvidence.mockResolvedValue({
      status: SelectedPullRequestEvidenceAvailability.Available,
      value: checksEvidence(),
    });
    mocks.runBranchViewRead.mockImplementation(
      async (
        _input: unknown,
        read: (octokit: unknown) => Promise<unknown>
      ) => ({ ok: true, value: await read(OCTOKIT) })
    );
  });

  it("replaces persisted null/28 with complete selected-PR evidence", async () => {
    const result =
      await branchSelectedPullRequestChecksService.enrichBranchDetail(
        ORGANIZATION_ID,
        USER_ID,
        branchDetail()
      );

    expect(result.checksStatus).toBe(ChecksStatus.Passing);
    expect(result.checksPassed).toBe(28);
    expect(result.checksTotal).toBe(28);
    expect(result.selectedPullRequestChecks?.status).toBe(
      BranchSelectedPullRequestChecksAvailability.Available
    );
  });

  it("clears persisted legacy counts without reading GitHub when selection is unavailable", async () => {
    const detail = branchDetail();
    detail.associatedPullRequests = undefined;

    const result =
      await branchSelectedPullRequestChecksService.enrichBranchDetail(
        ORGANIZATION_ID,
        USER_ID,
        detail
      );

    expect(result).toEqual({
      ...detail,
      checksStatus: null,
      checksPassed: null,
      checksTotal: null,
    });
    expect(mocks.runBranchViewRead).not.toHaveBeenCalled();
  });

  it("keeps partial evidence additive and clears legacy counts", async () => {
    mocks.getChecksEvidence.mockResolvedValueOnce({
      status: SelectedPullRequestEvidenceAvailability.Available,
      value: {
        ...checksEvidence(),
        coverage: {
          completeness: SelectedPullRequestChecksCompleteness.Partial,
          reasons: [SelectedPullRequestChecksPartialReason.CountMismatch],
        },
      },
    });

    const result =
      await branchSelectedPullRequestChecksService.enrichBranchDetail(
        ORGANIZATION_ID,
        USER_ID,
        branchDetail()
      );

    expect(result.checksStatus).toBeNull();
    expect(result.checksPassed).toBeNull();
    expect(result.checksTotal).toBeNull();
    expect(result.selectedPullRequestChecks?.status).toBe(
      BranchSelectedPullRequestChecksAvailability.Available
    );
  });

  it("rejects available evidence that fails the attach-time selected identity check", async () => {
    vi.spyOn(
      branchSelectedPullRequestChecksService,
      "getChecks"
    ).mockResolvedValueOnce({
      response: {
        status: BranchSelectedPullRequestChecksAvailability.Available,
        value: {
          ...checksEvidence({ number: PULL_REQUEST_NUMBER + 1 }),
          summary: BranchSelectedPullRequestChecksSummary.Successful,
        },
      },
      legacy: {
        checksStatus: ChecksStatus.Passing,
        checksPassed: 28,
        checksTotal: 28,
      },
    });

    const result =
      await branchSelectedPullRequestChecksService.enrichBranchDetail(
        ORGANIZATION_ID,
        USER_ID,
        branchDetail()
      );

    expect(result.checksStatus).toBeNull();
    expect(result.checksPassed).toBeNull();
    expect(result.checksTotal).toBeNull();
    expect(result.selectedPullRequestChecks).toBeUndefined();
  });
});

function expectedSelection() {
  return {
    headSha: "a".repeat(40),
    repositoryFullName: REPOSITORY_FULL_NAME,
    pullRequestNumber: PULL_REQUEST_NUMBER,
  };
}

function branchRow() {
  return {
    id: BRANCH_ID,
    organizationId: ORGANIZATION_ID,
    branch: {
      headSha: "a".repeat(40),
      repositoryId: "repository-id",
      repositoryFullName: REPOSITORY_FULL_NAME,
      repository: { fullName: REPOSITORY_FULL_NAME },
    },
    pullRequestDetails: [
      {
        branchArtifactId: BRANCH_ID,
        repositoryId: "repository-id",
        repositoryFullName: REPOSITORY_FULL_NAME,
        repository: { fullName: REPOSITORY_FULL_NAME },
        number: PULL_REQUEST_NUMBER,
        title: "Selected PR",
        htmlUrl: `https://github.com/${REPOSITORY_FULL_NAME}/pull/${PULL_REQUEST_NUMBER}`,
        prState: GitHubPRState.Open,
        isDraft: false,
        reviewDecision: ReviewDecision.Approved,
        githubCreatedAt: new Date("2026-08-01T00:00:00.000Z"),
        closedAt: null,
        mergedAt: null,
        lastVerifiedAt: new Date("2026-08-04T00:00:00.000Z"),
        headRefOid: "a".repeat(40),
      },
    ],
  };
}

function checksEvidence(
  overrides: { headSha?: string; number?: number } = {}
): SelectedPullRequestChecksEvidence {
  return {
    identity: {
      githubId: "123",
      repositoryFullName: REPOSITORY_FULL_NAME,
      number: overrides.number ?? PULL_REQUEST_NUMBER,
      url: `https://github.com/${REPOSITORY_FULL_NAME}/pull/${overrides.number ?? PULL_REQUEST_NUMBER}`,
    },
    revision: { headSha: overrides.headSha ?? "a".repeat(40) },
    checks: [],
    counts: {
      providerExpected: 28,
      providerReturned: 28,
      normalizedAttempts: 28,
      emitted: 28,
      total: 28,
      successful: 28,
      failing: 0,
      pending: 0,
      neutral: 0,
    },
    pagination: {
      pageSize: 100,
      pagesFetched: 1,
      acquisitionMaximum: 3000,
      reachedAcquisitionMaximum: false,
    },
    history: {
      mode: SelectedPullRequestChecksHistoryMode.LatestPerSourceFromProviderRollup,
      providerLimit: null,
      rawAttempts: 28,
      emittedSources: 28,
    },
    coverage: {
      completeness: SelectedPullRequestChecksCompleteness.Complete,
      reasons: [],
    },
  };
}

function branchDetail(): BranchPageDetail {
  return {
    id: BRANCH_ID,
    artifactId: BRANCH_ID,
    branchName: "feature/selected-pr-checks",
    baseBranch: "main",
    repoFullName: REPOSITORY_FULL_NAME,
    owner: "user",
    status: BranchStatus.Open,
    prNumber: PULL_REQUEST_NUMBER,
    prTitle: "Selected PR",
    prState: GitHubPRState.Open,
    prUrl: `https://github.com/${REPOSITORY_FULL_NAME}/pull/${PULL_REQUEST_NUMBER}`,
    multiPrWarning: false,
    checksStatus: null,
    checksPassed: null,
    checksTotal: 28,
    reviewDecision: null,
    ahead: null,
    behind: null,
    additions: null,
    deletions: null,
    filesChanged: null,
    estimatedCostUsd: null,
    lastActivityAt: "2026-08-04T00:00:00.000Z",
    sessionIds: [],
    associatedPullRequests: {
      items: [
        {
          id: `${REPOSITORY_FULL_NAME}#${PULL_REQUEST_NUMBER}`,
          repositoryFullName: REPOSITORY_FULL_NAME,
          number: PULL_REQUEST_NUMBER,
          title: "Selected PR",
          url: `https://github.com/${REPOSITORY_FULL_NAME}/pull/${PULL_REQUEST_NUMBER}`,
          state: GitHubPRState.Open,
          isDraft: false,
          reviewDecision: null,
          openedAt: null,
          closedAt: null,
          mergedAt: null,
        },
      ],
      selectedId: `${REPOSITORY_FULL_NAME}#${PULL_REQUEST_NUMBER}`,
      selectionReason: BranchAssociatedPullRequestSelectionReason.Active,
      completeness: {
        state: BranchAssociatedPullRequestCompletenessState.Complete,
        reasons: [],
        provenance: BranchAssociatedPullRequestProvenance.PersistedCloud,
      },
    },
    selectedPullRequest: {
      id: `${REPOSITORY_FULL_NAME}#${PULL_REQUEST_NUMBER}`,
      repositoryFullName: REPOSITORY_FULL_NAME,
      number: PULL_REQUEST_NUMBER,
      title: "Selected PR",
      url: `https://github.com/${REPOSITORY_FULL_NAME}/pull/${PULL_REQUEST_NUMBER}`,
      state: GitHubPRState.Open,
      isDraft: false,
      reviewDecision: null,
      openedAt: null,
      closedAt: null,
      mergedAt: null,
      body: null,
      headRefOid: "a".repeat(40),
      mergeCommitSha: null,
      changedFiles: null,
      additions: null,
      deletions: null,
    },
    prBody: null,
    prBodyHtmlUrl: null,
    headSha: "a".repeat(40),
    mergeCommitSha: null,
    mergedAt: null,
    closedAt: null,
    openedAt: null,
    commits: [],
    sessions: [],
    mergedTrace: [],
    leadTime: { firstActivityT: null, lastActivityT: null, idleSpans: [] },
    linkedPrNumbers: [PULL_REQUEST_NUMBER],
    linkedArtifacts: [],
  };
}
