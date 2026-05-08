import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  mockArtifactFindFirst,
  mockArtifactLinkFindFirst,
  mockInstallationRepositoryFindFirst,
  mockInstallationRepositoryFindUnique,
  mockGitHubInstallationFindMany,
  mockParsePullRequestMetadata,
  mockWithDb,
} = vi.hoisted(() => {
  const mockArtifactFindFirst = vi.fn();
  const mockArtifactLinkFindFirst = vi.fn();
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
          findFirst: mockArtifactLinkFindFirst,
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
    mockArtifactFindFirst,
    mockArtifactLinkFindFirst,
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
    PULL_REQUEST: "PULL_REQUEST",
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
  matchesParsedPullRequestIdentity,
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
    type: "PULL_REQUEST",
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

  it("ignores detail-backed PR rows that do not match the parsed URL", async () => {
    // Artifact exists with detail row that references a stale repositoryId.
    // The detail's number is 7, but the URL parses to 42 — so the identity
    // match against the repo's fullName/pullNumber must fail, and we must
    // fall back through resolveInstallationFallback to a single active
    // installation.
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

    // Resolve parent document link
    mockArtifactLinkFindFirst.mockResolvedValue({
      sourceId: "artifact-1",
    });

    // resolveInstallationFromRepository: repo's fullName doesn't match URL
    mockInstallationRepositoryFindUnique.mockResolvedValue({
      fullName: "acme/other-repo",
      installation: { installationId: "999", status: "ACTIVE" },
    });

    // Fallback path: single active installation
    mockGitHubInstallationFindMany.mockResolvedValue([
      { installationId: "123" },
    ]);
    mockInstallationRepositoryFindFirst.mockResolvedValue({
      id: "repo-correct",
    });

    const result = await resolvePrContext("ext-1", "org-1");

    expect(result).toMatchObject({
      installationId: "123",
      owner: "acme",
      repo: "repo",
      pullNumber: 42,
      // repositoryId prefers the detail's repositoryId (resolved first), then
      // falls back to the fallback-resolved one if detail was null. Detail
      // was present, so repositoryId === "repo-stale" (per impl logic).
      repositoryId: "repo-stale",
      gitHubPullRequest: expect.objectContaining({
        id: "ext-1",
        repositoryId: "repo-stale",
      }),
    });
  });
});
