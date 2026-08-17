import { ReviewDecision } from "@repo/api/src/types/branch-checks";
import {
  BRANCH_SELECTED_PULL_REQUEST_FILE_CONTENT_MAX_BYTES,
  BranchSelectedPullRequestAcquisitionUnavailableReason,
  BranchSelectedPullRequestFileCompleteness,
  BranchSelectedPullRequestReadAvailability,
  BranchSelectedPullRequestUnavailableSource,
} from "@repo/api/src/types/branch-selected-pull-request-files";
import {
  GitHubAccessDenialReason,
  GitHubPRState,
} from "@repo/api/src/types/github";
import {
  SelectedPullRequestContentAvailability,
  SelectedPullRequestContentClassification,
  SelectedPullRequestContentReferenceAvailability,
  SelectedPullRequestContentUnavailableReason,
  type SelectedPullRequestEvidence,
  SelectedPullRequestEvidenceAvailability,
  SelectedPullRequestEvidenceUnavailableReason,
  SelectedPullRequestFileCompleteness,
  SelectedPullRequestFileContentEvidenceAvailability,
  SelectedPullRequestFileStatus,
  SelectedPullRequestPatchAvailability,
  SelectedPullRequestPatchOmissionReason,
} from "@repo/api/src/types/selected-pull-request-evidence";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  acquireContent: vi.fn(),
  acquireEvidence: vi.fn(),
  artifactFindFirst: vi.fn(),
  branchHasCloudEligibility: vi.fn(),
  getContent: vi.fn(),
  getEvidence: vi.fn(),
  runBranchViewRead: vi.fn(),
  releaseContent: vi.fn(),
}));

vi.mock("@repo/database", () => ({
  ArtifactType: { BRANCH: "BRANCH" },
  withDb: (read: (db: unknown) => unknown) =>
    read({
      artifact: { findFirst: mocks.artifactFindFirst },
      $queryRaw: vi.fn(),
    }),
}));

vi.mock("@repo/github/selected-pull-request-evidence", () => ({
  getSelectedPullRequestEvidence: mocks.getEvidence,
}));

vi.mock("@repo/github/selected-pull-request-content-evidence", () => ({
  getSelectedPullRequestFileContentEvidence: mocks.getContent,
}));

vi.mock("@/lib/github/github-branch-view-read-client", () => ({
  runBranchViewRead: mocks.runBranchViewRead,
}));

vi.mock("./selected-pull-request-evidence-acquisition-budget", () => ({
  selectedPullRequestEvidenceAcquisitionBudget: {
    acquireContent: mocks.acquireContent,
    acquireEvidence: mocks.acquireEvidence,
  },
}));

vi.mock("./cloud-branch-eligibility", () => {
  return { branchHasCloudEligibility: mocks.branchHasCloudEligibility };
});

import { branchSelectedPullRequestFilesService } from "./branch-selected-pull-request-files-service";

const BRANCH_ID = "11111111-1111-4111-8111-111111111111";
const ORGANIZATION_ID = "22222222-2222-4222-8222-222222222222";
const USER_ID = "33333333-3333-4333-8333-333333333333";
const REPOSITORY_FULL_NAME = "closedloop-ai/symphony-alpha";
const PULL_REQUEST_NUMBER = 4471;
const BASE_SHA = "a".repeat(40);
const HEAD_SHA = "b".repeat(40);
const OCTOKIT = { marker: "octokit" };

describe("branchSelectedPullRequestFilesService", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.artifactFindFirst.mockResolvedValue(branchRow());
    mocks.branchHasCloudEligibility.mockResolvedValue(true);
    mocks.getEvidence.mockResolvedValue({
      status: SelectedPullRequestEvidenceAvailability.Available,
      value: evidence(),
    });
    mocks.getContent.mockResolvedValue(contentEvidence());
    mocks.acquireEvidence.mockImplementation(
      async (
        _key: unknown,
        _signal: AbortSignal | undefined,
        factory: (signal: AbortSignal) => Promise<unknown>
      ) => ({
        admitted: true,
        value: await factory(new AbortController().signal),
      })
    );
    mocks.acquireContent.mockReturnValue({
      admitted: true,
      release: mocks.releaseContent,
    });
    mocks.runBranchViewRead.mockImplementation(
      async (
        _input: unknown,
        read: (octokit: unknown) => Promise<unknown>
      ) => ({
        ok: true,
        value: await read(OCTOKIT),
      })
    );
  });

  it("reads exact persisted PR evidence through the user-attributed client", async () => {
    const signal = new AbortController().signal;
    const result = await branchSelectedPullRequestFilesService.getFiles(
      ORGANIZATION_ID,
      USER_ID,
      BRANCH_ID,
      filesQuery(),
      signal
    );

    expect(mocks.artifactFindFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          id: BRANCH_ID,
          organizationId: ORGANIZATION_ID,
          type: "BRANCH",
          branch: { deletedAt: null },
        }),
      })
    );
    expect(mocks.branchHasCloudEligibility).toHaveBeenCalledWith(
      expect.anything(),
      ORGANIZATION_ID,
      BRANCH_ID
    );
    expect(mocks.runBranchViewRead).toHaveBeenCalledWith(
      {
        organizationId: ORGANIZATION_ID,
        userId: USER_ID,
        target: { owner: "closedloop-ai", repo: "symphony-alpha" },
      },
      expect.any(Function)
    );
    expect(mocks.getEvidence).toHaveBeenCalledWith(
      OCTOKIT,
      "closedloop-ai",
      "symphony-alpha",
      PULL_REQUEST_NUMBER,
      expect.any(AbortSignal)
    );
    expect(mocks.acquireEvidence).toHaveBeenCalledWith(
      acquisitionKey(),
      signal,
      expect.any(Function)
    );
    expect(result?.status).toBe(
      BranchSelectedPullRequestReadAvailability.Available
    );
    if (
      result?.status !== BranchSelectedPullRequestReadAvailability.Available
    ) {
      throw new Error("Expected available files response");
    }
    expect(result.value.counts.expected).toBe(2);
    expect(result.value.coverage.completeness).toBe(
      BranchSelectedPullRequestFileCompleteness.Complete
    );
  });

  it("does not read GitHub for an invisible Branch or mismatched persisted PR", async () => {
    mocks.branchHasCloudEligibility.mockResolvedValueOnce(false);
    await expect(
      branchSelectedPullRequestFilesService.getFiles(
        ORGANIZATION_ID,
        USER_ID,
        BRANCH_ID,
        filesQuery()
      )
    ).resolves.toBeNull();
    expect(mocks.runBranchViewRead).not.toHaveBeenCalled();

    mocks.branchHasCloudEligibility.mockResolvedValueOnce(true);
    mocks.artifactFindFirst.mockResolvedValueOnce(
      branchRow({ repositoryFullName: "other/repository" })
    );
    await expect(
      branchSelectedPullRequestFilesService.getFiles(
        ORGANIZATION_ID,
        USER_ID,
        BRANCH_ID,
        filesQuery()
      )
    ).resolves.toBeNull();
    expect(mocks.runBranchViewRead).not.toHaveBeenCalled();
  });

  it("authorizes an exact persisted PR even when default selection is ambiguous", async () => {
    const row = branchRow();
    const existing = row.pullRequestDetails[0];
    if (!existing) {
      throw new Error("Expected the selected PR fixture");
    }
    row.pullRequestDetails.push({
      ...existing,
      id: "second-pull-request-detail-id",
      number: PULL_REQUEST_NUMBER + 1,
      htmlUrl: `https://github.com/${REPOSITORY_FULL_NAME}/pull/${PULL_REQUEST_NUMBER + 1}`,
    });
    mocks.artifactFindFirst.mockResolvedValueOnce(row);

    const result = await branchSelectedPullRequestFilesService.getFiles(
      ORGANIZATION_ID,
      USER_ID,
      BRANCH_ID,
      filesQuery()
    );
    expect(result?.status).toBe(
      BranchSelectedPullRequestReadAvailability.Available
    );
    expect(mocks.runBranchViewRead).toHaveBeenCalledTimes(1);
  });

  it("preserves access and landed provider failures", async () => {
    mocks.runBranchViewRead.mockResolvedValueOnce({
      ok: false,
      error: {
        reason: GitHubAccessDenialReason.RateLimited,
        retryAfterSeconds: 30,
      },
    });
    await expect(
      branchSelectedPullRequestFilesService.getFiles(
        ORGANIZATION_ID,
        USER_ID,
        BRANCH_ID,
        filesQuery()
      )
    ).resolves.toEqual({
      status: BranchSelectedPullRequestReadAvailability.Unavailable,
      source: BranchSelectedPullRequestUnavailableSource.Access,
      reason: GitHubAccessDenialReason.RateLimited,
      retryAfterSeconds: 30,
    });

    mocks.getEvidence.mockResolvedValueOnce({
      status: SelectedPullRequestEvidenceAvailability.Unavailable,
      reason: SelectedPullRequestEvidenceUnavailableReason.ProviderTimedOut,
    });
    await expect(
      branchSelectedPullRequestFilesService.getFiles(
        ORGANIZATION_ID,
        USER_ID,
        BRANCH_ID,
        filesQuery()
      )
    ).resolves.toEqual({
      status: BranchSelectedPullRequestReadAvailability.Unavailable,
      source: BranchSelectedPullRequestUnavailableSource.Evidence,
      reason: SelectedPullRequestEvidenceUnavailableReason.ProviderTimedOut,
    });
  });

  it("keeps unexpected evidence failures outside the access taxonomy", async () => {
    const unexpectedError = new Error("unexpected evidence failure");
    mocks.getEvidence.mockRejectedValueOnce(unexpectedError);

    await expect(
      branchSelectedPullRequestFilesService.getFiles(
        ORGANIZATION_ID,
        USER_ID,
        BRANCH_ID,
        filesQuery()
      )
    ).rejects.toBe(unexpectedError);
  });

  it("fails closed when provider evidence identity differs from the selected PR", async () => {
    mocks.getEvidence.mockResolvedValueOnce({
      status: SelectedPullRequestEvidenceAvailability.Available,
      value: evidence({ repositoryFullName: "other/repository" }),
    });

    await expect(
      branchSelectedPullRequestFilesService.getFiles(
        ORGANIZATION_ID,
        USER_ID,
        BRANCH_ID,
        filesQuery()
      )
    ).resolves.toEqual({
      status: BranchSelectedPullRequestReadAvailability.Unavailable,
      source: BranchSelectedPullRequestUnavailableSource.Evidence,
      reason: SelectedPullRequestEvidenceUnavailableReason.MalformedResponse,
    });
  });

  it("rejects a changed revision before content acquisition", async () => {
    const result = await branchSelectedPullRequestFilesService.getDiff(
      ORGANIZATION_ID,
      USER_ID,
      BRANCH_ID,
      {
        ...filesQuery(),
        path: "file.ts",
        baseSha: "c".repeat(40),
        headSha: HEAD_SHA,
      }
    );

    expect(result).toEqual({
      status: BranchSelectedPullRequestReadAvailability.Unavailable,
      source: BranchSelectedPullRequestUnavailableSource.Evidence,
      reason: SelectedPullRequestEvidenceUnavailableReason.StaleRevision,
    });
    expect(mocks.getContent).not.toHaveBeenCalled();
  });

  it("reads matching immutable file content with the bounded application limit", async () => {
    const signal = new AbortController().signal;
    const result = await branchSelectedPullRequestFilesService.getDiff(
      ORGANIZATION_ID,
      USER_ID,
      BRANCH_ID,
      diffQuery(),
      signal
    );

    expect(mocks.getContent).toHaveBeenCalledWith(
      OCTOKIT,
      evidence(),
      "file.ts",
      BRANCH_SELECTED_PULL_REQUEST_FILE_CONTENT_MAX_BYTES,
      signal
    );
    expect(mocks.acquireEvidence).toHaveBeenCalledWith(
      acquisitionKey(),
      signal,
      expect.any(Function)
    );
    expect(mocks.acquireContent).toHaveBeenCalledWith(acquisitionKey());
    expect(mocks.releaseContent).toHaveBeenCalledOnce();
    expect(result?.status).toBe(
      BranchSelectedPullRequestReadAvailability.Available
    );
  });

  it("projects classified binary evidence through the production service", async () => {
    mocks.getContent.mockResolvedValueOnce({
      status: SelectedPullRequestFileContentEvidenceAvailability.Available,
      value: {
        file: file(),
        base: {
          availability: SelectedPullRequestContentAvailability.Unavailable,
          classification: SelectedPullRequestContentClassification.Binary,
          reason: SelectedPullRequestContentUnavailableReason.BinaryContent,
        },
        head: {
          availability: SelectedPullRequestContentAvailability.Unavailable,
          classification: SelectedPullRequestContentClassification.Binary,
          reason: SelectedPullRequestContentUnavailableReason.BinaryContent,
        },
      },
    });

    const result = await branchSelectedPullRequestFilesService.getDiff(
      ORGANIZATION_ID,
      USER_ID,
      BRANCH_ID,
      diffQuery()
    );

    expect(result).toMatchObject({
      status: BranchSelectedPullRequestReadAvailability.Available,
      value: {
        diff: {
          oldContent: "",
          newContent: "",
          isBinary: true,
        },
      },
    });
  });

  it("keeps unexpected content failures outside the access taxonomy", async () => {
    const unexpectedError = new Error("unexpected content failure");
    mocks.getContent.mockRejectedValueOnce(unexpectedError);

    await expect(
      branchSelectedPullRequestFilesService.getDiff(
        ORGANIZATION_ID,
        USER_ID,
        BRANCH_ID,
        diffQuery()
      )
    ).rejects.toBe(unexpectedError);
    expect(mocks.releaseContent).toHaveBeenCalledOnce();
  });

  it("releases the content permit after caller cancellation", async () => {
    const controller = new AbortController();
    const cancellation = new DOMException("cancelled", "AbortError");
    mocks.getContent.mockImplementationOnce(() => {
      controller.abort(cancellation);
      return Promise.reject(cancellation);
    });

    await expect(
      branchSelectedPullRequestFilesService.getDiff(
        ORGANIZATION_ID,
        USER_ID,
        BRANCH_ID,
        diffQuery(),
        controller.signal
      )
    ).rejects.toBe(cancellation);
    expect(mocks.releaseContent).toHaveBeenCalledOnce();
  });

  it("returns typed acquisition denial without starting provider work", async () => {
    mocks.acquireEvidence.mockResolvedValueOnce({
      admitted: false,
      retryAfterSeconds: 2,
    });

    await expect(
      branchSelectedPullRequestFilesService.getFiles(
        ORGANIZATION_ID,
        USER_ID,
        BRANCH_ID,
        filesQuery()
      )
    ).resolves.toEqual(acquisitionUnavailableResponse());
    expect(mocks.getEvidence).not.toHaveBeenCalled();
  });

  it("returns typed content denial without starting content work", async () => {
    mocks.acquireContent.mockReturnValueOnce({
      admitted: false,
      retryAfterSeconds: 2,
    });

    await expect(
      branchSelectedPullRequestFilesService.getDiff(
        ORGANIZATION_ID,
        USER_ID,
        BRANCH_ID,
        diffQuery()
      )
    ).resolves.toEqual(acquisitionUnavailableResponse());
    expect(mocks.getContent).not.toHaveBeenCalled();
    expect(mocks.releaseContent).not.toHaveBeenCalled();
  });
});

function filesQuery() {
  return {
    repositoryFullName: REPOSITORY_FULL_NAME,
    pullRequestNumber: PULL_REQUEST_NUMBER,
  };
}

function acquisitionKey() {
  return {
    organizationId: ORGANIZATION_ID,
    userId: USER_ID,
    repositoryFullName: REPOSITORY_FULL_NAME,
    pullRequestNumber: PULL_REQUEST_NUMBER,
  };
}

function acquisitionUnavailableResponse() {
  return {
    status: BranchSelectedPullRequestReadAvailability.Unavailable,
    source: BranchSelectedPullRequestUnavailableSource.Acquisition,
    reason:
      BranchSelectedPullRequestAcquisitionUnavailableReason.BudgetExhausted,
    retryAfterSeconds: 2,
  };
}

function diffQuery() {
  return {
    ...filesQuery(),
    path: "file.ts",
    baseSha: BASE_SHA,
    headSha: HEAD_SHA,
  };
}

function branchRow(
  overrides: { repositoryFullName?: string; changedFiles?: number | null } = {}
) {
  const repositoryFullName =
    overrides.repositoryFullName ?? REPOSITORY_FULL_NAME;
  return {
    id: BRANCH_ID,
    organizationId: ORGANIZATION_ID,
    branch: {
      repositoryId: "repository-id",
      repositoryFullName,
      repository: { fullName: repositoryFullName },
    },
    pullRequestDetails: [
      {
        id: "pull-request-detail-id",
        branchArtifactId: BRANCH_ID,
        repositoryId: "repository-id",
        repositoryFullName,
        repository: { fullName: repositoryFullName },
        number: PULL_REQUEST_NUMBER,
        title: "Selected PR",
        htmlUrl: `https://github.com/${repositoryFullName}/pull/${PULL_REQUEST_NUMBER}`,
        prState: GitHubPRState.Open,
        isDraft: false,
        reviewDecision: ReviewDecision.Approved,
        githubCreatedAt: new Date("2026-08-01T00:00:00.000Z"),
        closedAt: null,
        mergedAt: null,
        lastVerifiedAt: new Date("2026-08-04T00:00:00.000Z"),
        changedFiles:
          overrides.changedFiles === undefined ? 2 : overrides.changedFiles,
      },
    ],
  };
}

function evidence(
  identityOverrides: { repositoryFullName?: string; number?: number } = {}
): SelectedPullRequestEvidence {
  return {
    identity: {
      githubId: "123",
      repositoryFullName:
        identityOverrides.repositoryFullName ?? REPOSITORY_FULL_NAME,
      number: identityOverrides.number ?? PULL_REQUEST_NUMBER,
      url: `https://github.com/${REPOSITORY_FULL_NAME}/pull/${PULL_REQUEST_NUMBER}`,
    },
    revision: { baseSha: BASE_SHA, headSha: HEAD_SHA },
    files: [file(), file({ path: "second.ts" })],
    counts: { expected: 2, providerReturned: 2, normalizedReturned: 2 },
    pagination: {
      pageSize: 100,
      pagesFetched: 1,
      providerMaximum: 3000,
      reachedProviderMaximum: false,
    },
    coverage: {
      completeness: SelectedPullRequestFileCompleteness.Complete,
      reasons: [],
    },
  };
}

function file(
  overrides: Partial<SelectedPullRequestEvidence["files"][number]> = {}
): SelectedPullRequestEvidence["files"][number] {
  return {
    path: "file.ts",
    providerStatus: SelectedPullRequestFileStatus.Modified,
    status: SelectedPullRequestFileStatus.Modified,
    additions: 2,
    deletions: 3,
    changes: 5,
    patch: {
      availability: SelectedPullRequestPatchAvailability.Omitted,
      reason: SelectedPullRequestPatchOmissionReason.ProviderOmitted,
    },
    baseContent: {
      availability: SelectedPullRequestContentReferenceAvailability.Available,
      path: "file.ts",
      ref: BASE_SHA,
    },
    headContent: {
      availability: SelectedPullRequestContentReferenceAvailability.Available,
      path: "file.ts",
      ref: HEAD_SHA,
    },
    ...overrides,
  };
}

function contentEvidence() {
  return {
    status: SelectedPullRequestFileContentEvidenceAvailability.Available,
    value: {
      file: file(),
      base: {
        availability: SelectedPullRequestContentAvailability.Available,
        content: "old content",
      },
      head: {
        availability: SelectedPullRequestContentAvailability.Available,
        content: "new content",
      },
    },
  };
}
