import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  mockArtifactFindFirst,
  mockInstallationRepositoryFindMany,
  mockInstallationRepositoryFindFirst,
  mockInstallationRepositoryFindUnique,
  mockGitHubInstallationFindMany,
  mockParsePullRequestMetadata,
  mockWithDb,
} = vi.hoisted(() => {
  const mockArtifactFindFirst = vi.fn();
  const mockInstallationRepositoryFindMany = vi.fn();
  const mockInstallationRepositoryFindFirst = vi.fn();
  const mockInstallationRepositoryFindUnique = vi.fn();
  const mockGitHubInstallationFindMany = vi.fn();
  const mockParsePullRequestMetadata = vi.fn();
  const mockWithDb = Object.assign(
    vi.fn((fn: (db: unknown) => unknown) =>
      fn({
        artifact: {
          findFirst: mockArtifactFindFirst,
        },
        artifactLink: {
          findFirst: vi.fn(),
        },
        gitHubInstallationRepository: {
          findMany: mockInstallationRepositoryFindMany,
          findFirst: mockInstallationRepositoryFindFirst,
          findUnique: mockInstallationRepositoryFindUnique,
        },
        gitHubInstallation: {
          findMany: mockGitHubInstallationFindMany,
        },
      })
    ),
    { tx: vi.fn() }
  );

  return {
    mockArtifactFindFirst,
    mockInstallationRepositoryFindMany,
    mockInstallationRepositoryFindFirst,
    mockInstallationRepositoryFindUnique,
    mockGitHubInstallationFindMany,
    mockParsePullRequestMetadata,
    mockWithDb,
  };
});

vi.mock("@repo/api/src/types/external-link-utils", () => ({
  parsePullRequestMetadata: mockParsePullRequestMetadata,
}));

vi.mock("@repo/database", () => ({
  ArtifactType: {
    DOCUMENT: "DOCUMENT",
    BRANCH: "BRANCH",
    DEPLOYMENT: "DEPLOYMENT",
  },
  GitHubInstallationStatus: { ACTIVE: "ACTIVE" },
  withDb: mockWithDb,
}));

vi.mock("@repo/observability/log", () => ({
  log: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

import {
  BranchViewContextCredentialMode,
  BranchViewContextCredentialSource,
  resolvePrContext,
} from "@/lib/resolve-pr-context";

/**
 * Build an Artifact row (with pullRequest detail) that matches the
 * shape returned by `db.artifact.findFirst` with `include: { pullRequest: true }`.
 */
function makePrArtifactRow(partial: {
  id: string;
  organizationId: string;
  workstreamId?: string | null;
  projectId?: string;
  name?: string;
  externalUrl?: string;
  detail: {
    repositoryId: string;
    githubId?: string;
    number: number;
    headBranch?: string;
    baseBranch?: string;
    headSha?: string | null;
    prState?: string;
    lastVerifiedAt?: Date | null;
    lastRefreshAttemptAt?: Date | null;
  } | null;
}) {
  return {
    id: partial.id,
    organizationId: partial.organizationId,
    workstreamId: partial.workstreamId ?? "work-1",
    projectId: partial.projectId ?? "proj-1",
    type: "BRANCH",
    subtype: null,
    name: partial.name ?? "PR 42",
    slug: null,
    assigneeId: null,
    status: "OPEN",
    priority: null,
    dueDate: null,
    externalUrl: partial.externalUrl ?? "https://github.com/acme/repo/pull/42",
    sortOrder: null,
    createdAt: new Date(),
    createdById: null,
    updatedAt: new Date(),
    pullRequest: partial.detail
      ? {
          id: partial.id,
          artifactId: partial.id,
          repositoryId: partial.detail.repositoryId,
          githubId: partial.detail.githubId ?? "stale-123",
          number: partial.detail.number,
          body: null,
          headBranch: partial.detail.headBranch ?? "feature",
          baseBranch: partial.detail.baseBranch ?? "main",
          headSha: partial.detail.headSha ?? null,
          prState: partial.detail.prState ?? "OPEN",
          isDraft: false,
          checksStatus: "UNKNOWN",
          reviewDecision: null,
          closedAt: null,
          mergedAt: null,
          mergeCommitSha: null,
          lastVerifiedAt: partial.detail.lastVerifiedAt ?? null,
          lastRefreshAttemptAt: partial.detail.lastRefreshAttemptAt ?? null,
        }
      : null,
  };
}

function makeBranchArtifactRow(partial?: {
  installationOrganizationId?: string | null;
  installationStatus?: string;
  currentPullRequestDetail?: {
    branchArtifactId?: string;
    repositoryId?: string;
  } | null;
}) {
  const artifactId = "branch-1";
  const repositoryId = "repo-1";
  return {
    id: artifactId,
    organizationId: "org-1",
    workstreamId: "work-1",
    projectId: "proj-1",
    name: "feature-branch",
    status: "OPEN",
    externalUrl: "https://github.com/acme/repo/tree/feature-branch",
    createdBy: { githubUsername: "octocat" },
    branch: {
      artifactId,
      repositoryId,
      branchName: "feature-branch",
      baseBranch: "main",
      baseBranchSource: "pull_request_base",
      headSha: "head-sha",
      headShaSource: "pull_request_webhook",
      headShaObservedAt: null,
      lastPushBeforeSha: null,
      currentPullRequestDetailId:
        partial?.currentPullRequestDetail === null ? null : "pr-detail-1",
      checksStatus: "UNKNOWN",
      fileCacheStatus: "absent",
      fileCacheHeadSha: null,
      fileCacheFileCount: 0,
      fileCachePatchBytes: 0,
      fileCacheUpdatedAt: null,
      syncStatus: "idle",
      lastSyncStartedAt: null,
      lastSyncCompletedAt: null,
      lastSyncErrorCode: null,
      lastSyncErrorMessage: null,
      currentPullRequestDetail:
        partial?.currentPullRequestDetail === null
          ? null
          : {
              id: "pr-detail-1",
              artifactId: null,
              branchArtifactId:
                partial?.currentPullRequestDetail?.branchArtifactId ??
                artifactId,
              repositoryId:
                partial?.currentPullRequestDetail?.repositoryId ?? repositoryId,
              githubId: "github-pr-1",
              number: 42,
              title: "Current PR",
              htmlUrl: "https://github.com/acme/repo/pull/42",
              prState: "OPEN",
              isDraft: false,
              reviewDecision: null,
            },
      repository: {
        id: repositoryId,
        githubRepoId: "github-repo-1",
        fullName: "acme/repo",
        removedAt: null,
        installation: {
          installationId: "install-1",
          organizationId: partial?.installationOrganizationId ?? "org-1",
          status: partial?.installationStatus ?? "ACTIVE",
        },
      },
    },
  };
}

describe("resolvePrContext", () => {
  beforeEach(() => {
    vi.clearAllMocks();

    mockParsePullRequestMetadata.mockReturnValue({
      githubId: "stale-123",
      number: 42,
      headBranch: "feature",
      baseBranch: "main",
      state: "OPEN",
    });
    mockInstallationRepositoryFindMany.mockResolvedValue([]);
    mockGitHubInstallationFindMany.mockResolvedValue([]);
  });

  it("returns null for branch artifacts that lack branch detail", async () => {
    mockArtifactFindFirst.mockResolvedValue(
      makePrArtifactRow({
        id: "ext-1",
        organizationId: "org-1",
        detail: {
          repositoryId: "repo-stale",
          number: 7,
          headSha: "head-stale",
        },
      })
    );

    const result = await resolvePrContext("ext-1", "org-1");

    expect(result).toBeNull();
    expect(mockGitHubInstallationFindMany).not.toHaveBeenCalled();
    expect(mockInstallationRepositoryFindFirst).not.toHaveBeenCalled();
    expect(mockInstallationRepositoryFindUnique).not.toHaveBeenCalled();
  });

  it("scopes artifact lookup by external link id and authenticated organization", async () => {
    mockArtifactFindFirst.mockResolvedValue(null);

    const result = await resolvePrContext("missing-branch", "org-1");

    expect(result).toBeNull();
    expect(mockArtifactFindFirst).toHaveBeenCalledWith({
      where: {
        id: "missing-branch",
        organizationId: "org-1",
        type: "BRANCH",
      },
      include: expect.any(Object),
    });
    expect(mockGitHubInstallationFindMany).not.toHaveBeenCalled();
    expect(mockInstallationRepositoryFindFirst).not.toHaveBeenCalled();
    expect(mockInstallationRepositoryFindUnique).not.toHaveBeenCalled();
  });

  it("returns null when the branch repository installation belongs to another org", async () => {
    mockArtifactFindFirst.mockResolvedValue(
      makeBranchArtifactRow({ installationOrganizationId: "other-org" })
    );

    const result = await resolvePrContext("branch-1", "org-1");

    expect(result).toBeNull();
    expect(mockInstallationRepositoryFindMany).not.toHaveBeenCalled();
  });

  it("keeps stale pinned repositories fail-closed by default", async () => {
    mockArtifactFindFirst.mockResolvedValue(
      makeBranchArtifactRow({ installationStatus: "UNINSTALLED" })
    );

    const result = await resolvePrContext("branch-1", "org-1");

    expect(result).toBeNull();
    expect(mockInstallationRepositoryFindMany).not.toHaveBeenCalled();
  });

  it("uses a same-org active sibling credential for explicit render reads", async () => {
    mockArtifactFindFirst.mockResolvedValue(
      makeBranchArtifactRow({
        installationOrganizationId: null,
        installationStatus: "UNINSTALLED",
      })
    );
    mockInstallationRepositoryFindMany.mockResolvedValue([
      {
        id: "active-repo-1",
        githubRepoId: "github-repo-1",
        fullName: "acme/renamed-repo",
        installationId: "active-installation-row-1",
      },
    ]);
    mockGitHubInstallationFindMany.mockResolvedValue([
      {
        id: "active-installation-row-1",
        installationId: "install-active",
      },
    ]);

    const result = await resolvePrContext("branch-1", "org-1", {
      credentialMode: BranchViewContextCredentialMode.RenderRead,
    });

    expect(result).toMatchObject({
      repositoryId: "repo-1",
      pinnedRepositoryId: "repo-1",
      credentialRepositoryId: "active-repo-1",
      credentialSource: BranchViewContextCredentialSource.ActiveSibling,
      githubRepoId: "github-repo-1",
      installationId: "install-active",
      owner: "acme",
      repo: "renamed-repo",
      gitHubPullRequest: {
        repositoryId: "repo-1",
        number: 42,
      },
    });
    expect(mockInstallationRepositoryFindMany).toHaveBeenCalledWith({
      where: {
        githubRepoId: "github-repo-1",
        removedAt: null,
        installation: {
          organizationId: "org-1",
          status: "ACTIVE",
        },
      },
      select: expect.any(Object),
    });
    expect(mockGitHubInstallationFindMany).toHaveBeenCalledWith({
      where: { id: { in: ["active-installation-row-1"] } },
      select: { id: true, installationId: true },
    });
  });

  it("fails closed when render-read active sibling lookup is ambiguous", async () => {
    mockArtifactFindFirst.mockResolvedValue(
      makeBranchArtifactRow({ installationStatus: "UNINSTALLED" })
    );
    mockInstallationRepositoryFindMany.mockResolvedValue([
      {
        id: "active-repo-1",
        githubRepoId: "github-repo-1",
        fullName: "acme/repo",
        installationId: "active-installation-row-1",
      },
      {
        id: "active-repo-2",
        githubRepoId: "github-repo-1",
        fullName: "acme/repo",
        installationId: "active-installation-row-2",
      },
    ]);
    mockGitHubInstallationFindMany.mockResolvedValue([
      {
        id: "active-installation-row-1",
        installationId: "install-active-1",
      },
      {
        id: "active-installation-row-2",
        installationId: "install-active-2",
      },
    ]);

    const result = await resolvePrContext("branch-1", "org-1", {
      credentialMode: BranchViewContextCredentialMode.RenderRead,
    });

    expect(result).toBeNull();
  });

  it("ignores a current PR detail that does not belong to the branch repository", async () => {
    mockArtifactFindFirst.mockResolvedValue(
      makeBranchArtifactRow({
        currentPullRequestDetail: { repositoryId: "foreign-repo" },
      })
    );

    const result = await resolvePrContext("branch-1", "org-1");

    expect(result).toMatchObject({
      branch: { currentPullRequestDetailId: null },
      gitHubPullRequest: null,
      prMetadata: null,
      repositoryId: "repo-1",
    });
  });

  it("ignores a current PR detail that does not belong to the branch artifact", async () => {
    mockArtifactFindFirst.mockResolvedValue(
      makeBranchArtifactRow({
        currentPullRequestDetail: { branchArtifactId: "other-branch" },
      })
    );

    const result = await resolvePrContext("branch-1", "org-1");

    expect(result).toMatchObject({
      branch: { currentPullRequestDetailId: null },
      gitHubPullRequest: null,
      prMetadata: null,
      repositoryId: "repo-1",
    });
    expect(result?.pullNumber).toBeNull();
  });
});
