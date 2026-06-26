import { describe, expect, it } from "vitest";
import { branchArtifactToInfo } from "@/lib/artifact-adapters";

/**
 * Build the shared Artifact scalar fields that every fixture needs.
 * `branchArtifactToInfo` only reads the fields included here;
 * relation fields (organization, project, etc.) are omitted.
 */
function makeBaseArtifact(externalUrl?: string | null) {
  return {
    id: "art-1",
    organizationId: "org-1",
    projectId: "proj-1",
    workstreamId: null,
    type: "BRANCH" as const,
    subtype: null,
    name: "feat: add feature",
    slug: null,
    assigneeId: null,
    status: "OPEN",
    priority: null,
    dueDate: null,
    externalUrl: externalUrl ?? "https://github.com/owner/repo/pull/1",
    sortOrder: null,
    createdAt: new Date("2024-01-01T00:00:00Z"),
    createdById: null,
    updatedAt: new Date("2024-01-01T00:00:00Z"),
  };
}

function makeDetailRow(repository: { fullName: string } | null) {
  return {
    artifactId: "art-1",
    repositoryId: "repo-1",
    githubId: "gh-123",
    number: 1,
    body: null,
    headBranch: "feat/add-feature",
    baseBranch: "main",
    headSha: null,
    prState: "OPEN" as const,
    isDraft: false,
    checksStatus: "UNKNOWN" as const,
    reviewDecision: null,
    closedAt: null,
    mergedAt: null,
    mergeCommitSha: null,
    lastVerifiedAt: null,
    lastRefreshAttemptAt: null,
    repository,
  };
}

function makeBranchDetail(repository: { fullName: string } | null) {
  return {
    branchName: "feat/add-feature",
    baseBranch: "main",
    headSha: null,
    checksStatus: "UNKNOWN" as const,
    repository,
    currentPullRequestDetail: makeDetailRow(repository),
  };
}

describe("branchArtifactToInfo", () => {
  it("returns null when pullRequest detail is absent", () => {
    const artifact = { ...makeBaseArtifact(), branch: null } as any;

    const result = branchArtifactToInfo(artifact);

    expect(result).toBeNull();
  });

  it("returns repoFullName from detail.repository.fullName when present", () => {
    const artifact = {
      ...makeBaseArtifact(),
      branch: makeBranchDetail({ fullName: "owner/repo" }),
    } as any;

    const result = branchArtifactToInfo(artifact);

    expect(result).not.toBeNull();
    expect(result?.repoFullName).toBe("owner/repo");
  });

  it("returns repoFullName from options.repoFullName when detail.repository is null", () => {
    const artifact = {
      ...makeBaseArtifact(),
      branch: makeBranchDetail(null),
    } as any;

    const result = branchArtifactToInfo(artifact, {
      repoFullName: "owner/fallback-repo",
    });

    expect(result).not.toBeNull();
    expect(result?.repoFullName).toBe("owner/fallback-repo");
  });

  it("returns repoFullName as null when options.repoFullName is undefined and detail.repository is null", () => {
    const artifact = {
      ...makeBaseArtifact(),
      branch: makeBranchDetail(null),
    } as any;

    const result = branchArtifactToInfo(artifact);

    expect(result).not.toBeNull();
    expect(result?.repoFullName).toBeNull();
  });

  it("prefers detail.repository.fullName over options.repoFullName", () => {
    const artifact = {
      ...makeBaseArtifact(),
      branch: makeBranchDetail({ fullName: "owner/repo-from-detail" }),
    } as any;

    const result = branchArtifactToInfo(artifact, {
      repoFullName: "owner/repo-from-options",
    });

    expect(result?.repoFullName).toBe("owner/repo-from-detail");
  });

  it("maps artifact scalar fields onto the returned PullRequestInfo", () => {
    const artifact = {
      ...makeBaseArtifact(),
      branch: makeBranchDetail({ fullName: "owner/repo" }),
    } as any;

    const result = branchArtifactToInfo(artifact, {
      externalLinkId: "link-99",
    });

    expect(result).not.toBeNull();
    expect(result?.id).toBe("art-1");
    expect(result?.name).toBe("feat: add feature");
    expect(result?.htmlUrl).toBe("https://github.com/owner/repo/pull/1");
    expect(result?.externalLinkId).toBe("link-99");
  });
});
