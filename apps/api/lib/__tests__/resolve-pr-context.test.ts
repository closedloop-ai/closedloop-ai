import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  mockExternalLinkFindFirst,
  mockGitHubPullRequestFindFirst,
  mockGitHubPullRequestFindUnique,
  mockInstallationRepositoryFindFirst,
  mockInstallationRepositoryFindUnique,
  mockGitHubInstallationFindMany,
  mockParsePullRequestMetadata,
  mockWithDb,
} = vi.hoisted(() => {
  const mockExternalLinkFindFirst = vi.fn();
  const mockGitHubPullRequestFindFirst = vi.fn();
  const mockGitHubPullRequestFindUnique = vi.fn();
  const mockInstallationRepositoryFindFirst = vi.fn();
  const mockInstallationRepositoryFindUnique = vi.fn();
  const mockGitHubInstallationFindMany = vi.fn();
  const mockParsePullRequestMetadata = vi.fn();
  const mockWithDb = Object.assign(
    vi.fn((fn: (db: unknown) => unknown) =>
      fn({
        externalLink: {
          findFirst: mockExternalLinkFindFirst,
        },
        gitHubPullRequest: {
          findFirst: mockGitHubPullRequestFindFirst,
          findUnique: mockGitHubPullRequestFindUnique,
        },
        gitHubInstallationRepository: {
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
    mockExternalLinkFindFirst,
    mockGitHubPullRequestFindFirst,
    mockGitHubPullRequestFindUnique,
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
  matchesParsedPullRequestIdentity,
  resolvePrContext,
} from "@/lib/resolve-pr-context";

describe("resolvePrContext", () => {
  beforeEach(() => {
    vi.clearAllMocks();

    mockExternalLinkFindFirst.mockResolvedValue({
      id: "ext-1",
      title: "PR 42",
      externalUrl: "https://github.com/acme/repo/pull/42",
      metadata: { githubId: "stale-123" },
      projectId: "proj-1",
      workstreamId: "work-1",
      organizationId: "org-1",
    });
    mockParsePullRequestMetadata.mockReturnValue({
      githubId: "stale-123",
      number: 42,
      headBranch: "feature",
      baseBranch: "main",
      state: "OPEN",
    });
    mockGitHubInstallationFindMany.mockResolvedValue([]);
  });

  it("matches repository identity case-insensitively", () => {
    expect(
      matchesParsedPullRequestIdentity(
        { owner: "Acme", repo: "Repo", pullNumber: 42 },
        { repositoryFullName: "acme/repo", pullNumber: 42 }
      )
    ).toBe(true);

    expect(
      matchesParsedPullRequestIdentity(
        { owner: "acme", repo: "repo", pullNumber: 42 },
        { repositoryFullName: "acme/other-repo", pullNumber: 42 }
      )
    ).toBe(false);
  });

  it("ignores metadata-backed PR rows that do not match the parsed URL", async () => {
    mockGitHubPullRequestFindFirst.mockResolvedValue({
      id: "pr-stale",
      repositoryId: "repo-stale",
      documentId: null,
      workstreamId: "work-stale",
      headSha: "head-stale",
      number: 7,
    });
    mockInstallationRepositoryFindUnique.mockResolvedValue({
      fullName: "acme/other-repo",
      installation: { installationId: "999", status: "ACTIVE" },
    });
    mockInstallationRepositoryFindFirst.mockResolvedValue({
      id: "repo-correct",
      installation: { installationId: "123" },
    });
    mockGitHubPullRequestFindUnique.mockResolvedValue({
      id: "pr-correct",
      repositoryId: "repo-correct",
      documentId: "artifact-1",
      workstreamId: "work-correct",
      headSha: "head-correct",
    });

    const result = await resolvePrContext("ext-1", "org-1");

    expect(result).toMatchObject({
      installationId: "123",
      repositoryId: "repo-correct",
      owner: "acme",
      repo: "repo",
      pullNumber: 42,
      gitHubPullRequest: {
        id: "pr-correct",
        repositoryId: "repo-correct",
      },
    });
    expect(mockGitHubPullRequestFindUnique).toHaveBeenCalledWith({
      where: {
        repositoryId_number: {
          repositoryId: "repo-correct",
          number: 42,
        },
      },
      select: {
        id: true,
        repositoryId: true,
        documentId: true,
        workstreamId: true,
        headSha: true,
      },
    });
  });
});
