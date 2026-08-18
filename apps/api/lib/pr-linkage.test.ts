import { GitHubPRState } from "@repo/api/src/types/github";
import {
  GitHubFetchCredentialType,
  GitHubFetchMechanism,
  GitHubFetchTrigger,
} from "@repo/api/src/types/github-read-model";
import {
  RepositoryDefaultAvailability,
  RepositoryDefaultCompleteness,
  RepositoryDefaultReason,
  RepositoryDefaultSource,
  repositoryDefaultAuthorityValidator,
} from "@repo/api/src/types/repository-default-identity";
import { Status } from "@repo/api/src/types/result";
import { VcsProviderKind } from "@repo/api/src/types/vcs-provider-kind";
import {
  GitHubProviderResultStatus,
  type GitHubSinglePullRequestResult,
} from "@repo/github";
import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  mockUpsertBranchArtifact,
  mockGetSinglePullRequest,
  mockReadWithInstallationClient,
} = vi.hoisted(() => ({
  mockUpsertBranchArtifact: vi.fn(),
  mockGetSinglePullRequest: vi.fn(),
  mockReadWithInstallationClient: vi.fn(),
}));

vi.mock("@/app/branches/branch-service", () => ({
  branchService: { upsertBranchArtifact: mockUpsertBranchArtifact },
}));

vi.mock("@repo/github", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@repo/github")>()),
  getSinglePullRequestWithProviderResult: mockGetSinglePullRequest,
}));

vi.mock("@/lib/github/installation-client", () => ({
  readWithInstallationClient: mockReadWithInstallationClient,
}));

vi.mock("@repo/observability/log", () => ({
  log: { info: vi.fn(), warn: vi.fn() },
}));

import { ensurePrLinkageRecords } from "./pr-linkage";

const input = {
  organizationId: "org-1",
  projectId: "project-1",
  documentId: "document-1",
  prNumber: 42,
  baseRepository: {
    id: "base-repository-row",
    fullName: "base-owner/base-repo",
    installationId: "12345",
  },
};

describe("ensurePrLinkageRecords", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockReadWithInstallationClient.mockImplementation((_installationId, read) =>
      read({})
    );
    mockGetSinglePullRequest.mockResolvedValue({
      status: GitHubProviderResultStatus.Success,
      value: makePullRequest(),
    });
    mockUpsertBranchArtifact.mockResolvedValue({
      ok: true,
      value: { id: "branch-1" },
    });
  });

  it("materializes an eligible feature head through the canonical service", async () => {
    await expect(ensurePrLinkageRecords(input)).resolves.toEqual({
      status: "linked",
      branchArtifactId: "branch-1",
    });
    expect(mockUpsertBranchArtifact).toHaveBeenCalledWith(
      expect.objectContaining({
        repositoryFullName: "base-owner/base-repo",
        repositoryId: "base-repository-row",
        branchName: "feature/cloud-correctness",
        sourceArtifactId: "document-1",
        pullRequestRepositoryId: "base-repository-row",
        pullRequestBaseRepositoryFullName: "base-owner/base-repo",
      })
    );
  });

  it("preserves fork head identity while retaining base PR context", async () => {
    mockGetSinglePullRequest.mockResolvedValue({
      status: GitHubProviderResultStatus.Success,
      value: makePullRequest({ headFullName: "contributor/fork" }),
    });

    await ensurePrLinkageRecords(input);

    expect(mockUpsertBranchArtifact).toHaveBeenCalledWith(
      expect.objectContaining({
        repositoryFullName: "contributor/fork",
        repositoryId: null,
        pullRequestRepositoryId: "base-repository-row",
        pullRequestBaseRepositoryFullName: "base-owner/base-repo",
      })
    );
  });

  it("does not enter the branch write boundary when head authority is missing", async () => {
    mockGetSinglePullRequest.mockResolvedValue({
      status: GitHubProviderResultStatus.Success,
      value: makePullRequest({ omitAuthority: true }),
    });

    await expect(ensurePrLinkageRecords(input)).resolves.toEqual({
      status: "not_materialized",
      reason: "head_authority_unavailable",
    });
    expect(mockUpsertBranchArtifact).not.toHaveBeenCalled();
  });

  it("does not write a branch or link when the provider read is unavailable", async () => {
    mockGetSinglePullRequest.mockResolvedValue({
      status: GitHubProviderResultStatus.ProviderUnavailable,
      retryAfterSeconds: null,
    });

    await expect(ensurePrLinkageRecords(input)).resolves.toEqual({
      status: "not_materialized",
      reason: "provider_unavailable",
    });
    expect(mockUpsertBranchArtifact).not.toHaveBeenCalled();
  });

  it.each([
    ["default head", makePullRequest({ headBranch: "main" })],
    ["stale authority", makePullRequest({ availability: "stale" })],
    ["conflicting authority", makePullRequest({ reason: "conflicting" })],
  ])("fails closed for %s without producing a linkage", async (_name, pr) => {
    mockGetSinglePullRequest.mockResolvedValue({
      status: GitHubProviderResultStatus.Success,
      value: pr,
    });
    mockUpsertBranchArtifact.mockResolvedValue({
      ok: false,
      error: Status.BadRequest,
    });

    await expect(ensurePrLinkageRecords(input)).resolves.toEqual({
      status: "not_materialized",
      reason: "branch_rejected",
    });
  });
});

function makePullRequest(
  overrides: {
    headFullName?: string;
    headBranch?: string;
    omitAuthority?: boolean;
    availability?: "available" | "stale";
    reason?: "conflicting";
  } = {}
): GitHubSinglePullRequestResult {
  const headFullName = overrides.headFullName ?? "base-owner/base-repo";
  const authority = repositoryDefaultAuthorityValidator.parse({
    repository: {
      provider: VcsProviderKind.GitHub,
      providerRepositoryId:
        headFullName === "base-owner/base-repo" ? "100" : "200",
      fullName: headFullName,
    },
    evidence: makeAuthorityEvidence(overrides),
    provenance: {
      source: RepositoryDefaultSource.PullRequestRest,
      mechanism: GitHubFetchMechanism.Rest,
      trigger: GitHubFetchTrigger.UserAction,
      credentialType: GitHubFetchCredentialType.GitHubApp,
      observationKey: "observation-1",
      observedAt: "2026-08-11T12:00:00.000Z",
    },
  });
  return {
    githubId: "9001",
    number: 42,
    title: "Cloud eligibility",
    htmlUrl: "https://github.com/base-owner/base-repo/pull/42",
    headBranch: overrides.headBranch ?? "feature/cloud-correctness",
    baseBranch: "main",
    state: GitHubPRState.Open,
    createdAt: "2026-08-11T10:00:00.000Z",
    mergedAt: null,
    closedAt: null,
    authorLogin: "contributor",
    isDraft: false,
    headSha: "abc123",
    baseSha: "def456",
    mergeCommitSha: null,
    ...(overrides.omitAuthority ? {} : { headRepository: authority }),
  };
}

function makeAuthorityEvidence(overrides: {
  availability?: "available" | "stale";
  reason?: "conflicting";
}) {
  if (overrides.availability === "stale") {
    return {
      availability: RepositoryDefaultAvailability.Stale,
      completeness: RepositoryDefaultCompleteness.Partial,
      defaultBranch: "main",
      reason: RepositoryDefaultReason.ProviderError,
    };
  }
  if (overrides.reason === "conflicting") {
    return {
      availability: RepositoryDefaultAvailability.Unavailable,
      completeness: RepositoryDefaultCompleteness.Partial,
      reason: RepositoryDefaultReason.Conflicting,
    };
  }
  return {
    availability: RepositoryDefaultAvailability.Available,
    completeness: RepositoryDefaultCompleteness.Complete,
    defaultBranch: "main",
  };
}
