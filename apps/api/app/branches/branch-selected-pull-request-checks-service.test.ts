import type { BranchPageDetail } from "@repo/api/src/types/branch";
import { ReviewDecision } from "@repo/api/src/types/branch-checks";
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
} from "@repo/api/src/types/selected-pull-request-checks-evidence";
import {
  SelectedPullRequestEvidenceAvailability,
  SelectedPullRequestEvidenceUnavailableReason,
} from "@repo/api/src/types/selected-pull-request-evidence";
import { beforeEach, describe, expect, it, vi } from "vitest";

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
const REPOSITORY_FULL_NAME = "closedloop-ai/closedloop-ai";
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
          branch: { isNot: null },
        },
      })
    );
    expect(mocks.runBranchViewRead).toHaveBeenCalledWith(
      {
        organizationId: ORGANIZATION_ID,
        userId: USER_ID,
        target: { owner: "closedloop-ai", repo: "closedloop-ai" },
      },
      expect.any(Function)
    );
    expect(mocks.getChecksEvidence).toHaveBeenCalledWith(
      OCTOKIT,
      "closedloop-ai",
      "closedloop-ai",
      PULL_REQUEST_NUMBER,
      {
        signal: controller.signal,
        timeoutMs: 50_000,
      }
    );
    expect(result).toEqual(
      expect.objectContaining({
        status: BranchSelectedPullRequestChecksAvailability.Available,
        value: expect.objectContaining({
          summary: BranchSelectedPullRequestChecksSummary.Successful,
        }),
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
      status: BranchSelectedPullRequestChecksAvailability.Unavailable,
      source: BranchSelectedPullRequestChecksUnavailableSource.Evidence,
      reason: SelectedPullRequestEvidenceUnavailableReason.StaleRevision,
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

  it("fails closed when Product eligibility disappears during context hydration", async () => {
    mocks.branchHasCloudEligibility
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false);

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

  it("fails closed when Product eligibility is revoked after stale context projection", async () => {
    const row = branchRow();
    const selected = row.pullRequestDetails[0];
    if (!selected) {
      throw new Error("Expected selected PR fixture");
    }
    row.pullRequestDetails[0] = {
      ...selected,
      headRefOid: "c".repeat(40),
    };
    mocks.artifactFindFirst.mockResolvedValueOnce(row);
    mockFinalEligibilityRevoked();

    await expect(
      branchSelectedPullRequestChecksService.getChecks(
        ORGANIZATION_ID,
        USER_ID,
        BRANCH_ID,
        expectedSelection()
      )
    ).resolves.toBeNull();
    expect(mocks.runBranchViewRead).not.toHaveBeenCalled();
    expect(mocks.branchHasCloudEligibility).toHaveBeenCalledTimes(3);
  });

  it("fails closed when Product eligibility is revoked after checks provider success", async () => {
    mockFinalEligibilityRevoked();

    await expect(
      branchSelectedPullRequestChecksService.getChecks(
        ORGANIZATION_ID,
        USER_ID,
        BRANCH_ID,
        expectedSelection()
      )
    ).resolves.toBeNull();
    expect(mocks.getChecksEvidence).toHaveBeenCalledTimes(1);
    expect(mocks.branchHasCloudEligibility).toHaveBeenCalledTimes(3);
  });

  it("fails closed when Product eligibility is revoked after checks access failure", async () => {
    mocks.runBranchViewRead.mockResolvedValueOnce({
      ok: false,
      error: {
        reason: GitHubAccessDenialReason.RateLimited,
        retryAfterSeconds: 20,
      },
    });
    mockFinalEligibilityRevoked();

    await expect(
      branchSelectedPullRequestChecksService.getChecks(
        ORGANIZATION_ID,
        USER_ID,
        BRANCH_ID,
        expectedSelection()
      )
    ).resolves.toBeNull();
    expect(mocks.runBranchViewRead).toHaveBeenCalledTimes(1);
    expect(mocks.branchHasCloudEligibility).toHaveBeenCalledTimes(3);
  });

  it("fails closed when Product eligibility is revoked after checks evidence failure", async () => {
    mocks.getChecksEvidence.mockResolvedValueOnce({
      status: SelectedPullRequestEvidenceAvailability.Unavailable,
      reason: SelectedPullRequestEvidenceUnavailableReason.ProviderTimedOut,
    });
    mockFinalEligibilityRevoked();

    await expect(
      branchSelectedPullRequestChecksService.getChecks(
        ORGANIZATION_ID,
        USER_ID,
        BRANCH_ID,
        expectedSelection()
      )
    ).resolves.toBeNull();
    expect(mocks.getChecksEvidence).toHaveBeenCalledTimes(1);
    expect(mocks.branchHasCloudEligibility).toHaveBeenCalledTimes(3);
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
    expect(result?.status).toBe(
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
      status: BranchSelectedPullRequestChecksAvailability.Unavailable,
      source: BranchSelectedPullRequestChecksUnavailableSource.Access,
      reason: GitHubAccessDenialReason.RateLimited,
      retryAfterSeconds: 20,
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
      status: BranchSelectedPullRequestChecksAvailability.Unavailable,
      source: BranchSelectedPullRequestChecksUnavailableSource.Evidence,
      reason: SelectedPullRequestEvidenceUnavailableReason.ProviderTimedOut,
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
      status: BranchSelectedPullRequestChecksAvailability.Unavailable,
      source: BranchSelectedPullRequestChecksUnavailableSource.Evidence,
      reason: SelectedPullRequestEvidenceUnavailableReason.MalformedResponse,
    });
  });

  it.each([`${REPOSITORY_FULL_NAME}/extra`, "closedloop-ai"])(
    "does not match the structurally invalid identity %s onto its first two segments (ISS-7548)",
    async (repositoryFullName) => {
      // The row and the expected selection agree on the name, so the identity
      // comparison passes and the parse is what rejects. Truncating
      // `owner/repo/extra` to `owner/repo` would read a DIFFERENT repository's
      // check runs and report them as this branch's.
      mocks.artifactFindFirst.mockResolvedValueOnce(
        branchRow(repositoryFullName)
      );

      const result = await branchSelectedPullRequestChecksService.getChecks(
        ORGANIZATION_ID,
        USER_ID,
        BRANCH_ID,
        expectedSelection(repositoryFullName)
      );

      expect(result?.status).toBe(
        BranchSelectedPullRequestChecksAvailability.Unavailable
      );
      expect(mocks.getChecksEvidence).not.toHaveBeenCalled();
    }
  );

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
      status: BranchSelectedPullRequestChecksAvailability.Unavailable,
      source: BranchSelectedPullRequestChecksUnavailableSource.Evidence,
      reason: SelectedPullRequestEvidenceUnavailableReason.StaleRevision,
    });
  });
});

describe("branchSelectedPullRequestChecksService.enrichBranchDetail (ISS-12278)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns a detail that names no selected PR unchanged, without reads", async () => {
    const detail = { id: BRANCH_ID } as BranchPageDetail;

    const result =
      await branchSelectedPullRequestChecksService.enrichBranchDetail(
        ORGANIZATION_ID,
        USER_ID,
        detail
      );

    expect(result).toBe(detail);
    expect(mocks.artifactFindFirst).not.toHaveBeenCalled();
    expect(mocks.getChecksEvidence).not.toHaveBeenCalled();
  });
});

describe("branchSelectedPullRequestChecksService.getChecks provider failure", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.artifactFindFirst.mockResolvedValue(branchRow());
    mocks.branchHasCloudEligibility.mockResolvedValue(true);
  });

  it("answers typed provider-failure evidence when acquisition throws", async () => {
    mocks.runBranchViewRead.mockRejectedValueOnce(
      new Error("credential acquisition failed")
    );

    const result = await branchSelectedPullRequestChecksService.getChecks(
      ORGANIZATION_ID,
      USER_ID,
      BRANCH_ID,
      expectedSelection()
    );

    expect(result).toEqual({
      status: BranchSelectedPullRequestChecksAvailability.Unavailable,
      source: BranchSelectedPullRequestChecksUnavailableSource.Evidence,
      reason: SelectedPullRequestEvidenceUnavailableReason.ProviderFailure,
    });
    expect(mocks.branchHasCloudEligibility).toHaveBeenCalledTimes(3);
  });

  it("still fails closed after acquisition throws", async () => {
    mocks.runBranchViewRead.mockRejectedValueOnce(
      new Error("credential acquisition failed")
    );
    mockFinalEligibilityRevoked();

    await expect(
      branchSelectedPullRequestChecksService.getChecks(
        ORGANIZATION_ID,
        USER_ID,
        BRANCH_ID,
        expectedSelection()
      )
    ).resolves.toBeNull();
  });

  it("rethrows an acquisition failure once the caller aborted", async () => {
    const controller = new AbortController();
    const failure = new Error("aborted");
    mocks.runBranchViewRead.mockImplementationOnce(() => {
      controller.abort();
      return Promise.reject(failure);
    });

    await expect(
      branchSelectedPullRequestChecksService.getChecks(
        ORGANIZATION_ID,
        USER_ID,
        BRANCH_ID,
        expectedSelection(),
        controller.signal
      )
    ).rejects.toBe(failure);
  });
});

function mockFinalEligibilityRevoked(): void {
  mocks.branchHasCloudEligibility
    .mockResolvedValueOnce(true)
    .mockResolvedValueOnce(true)
    .mockResolvedValueOnce(false);
}

function expectedSelection(repositoryFullName = REPOSITORY_FULL_NAME) {
  return {
    headSha: "a".repeat(40),
    repositoryFullName,
    pullRequestNumber: PULL_REQUEST_NUMBER,
  };
}

function branchRow(repositoryFullName = REPOSITORY_FULL_NAME) {
  return {
    id: BRANCH_ID,
    organizationId: ORGANIZATION_ID,
    branch: {
      headSha: "a".repeat(40),
      repositoryId: "repository-id",
      repositoryFullName,
      repository: { fullName: repositoryFullName },
    },
    pullRequestDetails: [
      {
        branchArtifactId: BRANCH_ID,
        repositoryId: "repository-id",
        repositoryFullName,
        repository: { fullName: repositoryFullName },
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
