import { ChecksStatus } from "@repo/api/src/types/branch-checks";
import { BranchProductEligibility } from "@repo/api/src/types/branch-product-eligibility";
import { GitHubPRState } from "@repo/api/src/types/github";
import { describe, expect, it } from "vitest";
import {
  branchArtifactToInfo,
  deploymentArtifactToInfo,
} from "@/lib/artifact-adapters";

/**
 * Minimal typed pull-request detail row, matching exactly the fields
 * `pullRequestDetailToInfo` reads (no excess Prisma-row baggage, no cast).
 */
function makeDetailRow(overrides: Record<string, unknown> = {}) {
  return {
    repositoryId: "repo-1",
    githubId: "gh-123",
    number: 1,
    body: null,
    prState: GitHubPRState.Open,
    isDraft: false,
    reviewDecision: null,
    closedAt: null,
    mergedAt: null,
    mergeCommitSha: null,
    lastVerifiedAt: null,
    lastRefreshAttemptAt: null,
    repository: { fullName: "owner/repo" } as { fullName: string } | null,
    htmlUrl: "https://github.com/owner/repo/pull/1",
    ...overrides,
  };
}

/** Minimal typed branch detail, matching exactly what `branchArtifactToInfo` reads. */
function makeBranchDetail(
  overrides: Record<string, unknown> = {},
  detailOverrides: Record<string, unknown> | null = {}
) {
  return {
    branchName: "feat/add-feature",
    baseBranch: "main" as string | null,
    headSha: null,
    checksStatus: ChecksStatus.Unknown as ChecksStatus | null,
    repository: { fullName: "owner/repo" } as { fullName: string } | null,
    currentPullRequestDetail:
      detailOverrides === null ? null : makeDetailRow(detailOverrides),
    ...overrides,
  };
}

/** Minimal typed branch artifact — only the four scalars `branchArtifactToInfo` reads. */
function makeArtifact(
  branch: ReturnType<typeof makeBranchDetail> | null,
  overrides: { externalUrl?: string | null } = {}
) {
  return {
    id: "art-1",
    name: "feat: add feature",
    externalUrl: "https://github.com/owner/repo/pull/1" as string | null,
    createdAt: new Date("2024-01-01T00:00:00Z"),
    branch,
    ...overrides,
  };
}

describe("branchArtifactToInfo — currentPullRequest presence", () => {
  it("nulls currentPullRequest when the branch has no currentPullRequestDetail", () => {
    const artifact = makeArtifact(makeBranchDetail({}, null));

    const result = branchArtifactToInfo(artifact);

    expect(result).not.toBeNull();
    expect(result?.currentPullRequest).toBeNull();
  });
});

describe("branchArtifactToInfo — nested pull request fallbacks", () => {
  it("falls back to an empty htmlUrl when neither the detail nor the artifact has one", () => {
    const artifact = makeArtifact(makeBranchDetail({}, { htmlUrl: null }), {
      externalUrl: null,
    });

    const result = branchArtifactToInfo(artifact);

    expect(result?.currentPullRequest?.htmlUrl).toBe("");
  });

  it("falls back to an empty baseBranch when the branch detail has none", () => {
    const artifact = makeArtifact(makeBranchDetail({ baseBranch: null }));

    const result = branchArtifactToInfo(artifact);

    expect(result?.currentPullRequest?.baseBranch).toBe("");
  });

  it("passes through a null checksStatus on the branch detail", () => {
    const artifact = makeArtifact(makeBranchDetail({ checksStatus: null }));

    const result = branchArtifactToInfo(artifact);

    expect(result?.currentPullRequest?.checksStatus).toBeNull();
  });
});

describe("branchArtifactToInfo — productEligibility / compatibility fallback propagation", () => {
  it("omits productEligibility and hasCompatibilityProviderFallback from both the branch and the nested PR when not requested", () => {
    const artifact = makeArtifact(makeBranchDetail());

    const result = branchArtifactToInfo(artifact);

    expect(result).not.toHaveProperty("productEligibility");
    expect(result).not.toHaveProperty("hasCompatibilityProviderFallback");
    expect(result?.currentPullRequest).not.toHaveProperty("productEligibility");
    expect(result?.currentPullRequest).not.toHaveProperty(
      "hasCompatibilityProviderFallback"
    );
  });

  it("propagates a requested productEligibility onto both the branch and the nested PR", () => {
    const artifact = makeArtifact(makeBranchDetail());

    const result = branchArtifactToInfo(artifact, {
      productEligibility: BranchProductEligibility.Eligible,
    });

    expect(result?.productEligibility).toBe(BranchProductEligibility.Eligible);
    expect(result?.currentPullRequest?.productEligibility).toBe(
      BranchProductEligibility.Eligible
    );
  });

  it("propagates a requested hasCompatibilityProviderFallback onto both the branch and the nested PR", () => {
    const artifact = makeArtifact(makeBranchDetail());

    const result = branchArtifactToInfo(artifact, {
      hasCompatibilityProviderFallback: true,
    });

    expect(result?.hasCompatibilityProviderFallback).toBe(true);
    expect(result?.currentPullRequest?.hasCompatibilityProviderFallback).toBe(
      true
    );
  });
});

describe("deploymentArtifactToInfo", () => {
  /** Minimal typed deployment artifact — exactly `DeploymentArtifactScalars`. */
  function makeDeploymentArtifact(
    deployment: {
      environment: string | null;
      ref: string | null;
      sha: string | null;
      githubStatusUrl: string | null;
      githubDeploymentUrl: string | null;
      transient: boolean | null;
      production: boolean | null;
      branchArtifactId: string | null;
    } | null
  ) {
    return {
      id: "art-2",
      organizationId: "org-1",
      projectId: "proj-1" as string | null,
      name: "prod deploy",
      slug: "prod-deploy" as string | null,
      status: "OPEN",
      priority: null,
      assigneeId: null,
      dueDate: null,
      externalUrl: null,
      sortOrder: null,
      createdAt: new Date("2024-01-01T00:00:00Z"),
      createdById: null,
      updatedAt: new Date("2024-01-01T00:00:00Z"),
      deployment,
    };
  }

  it("returns null when the artifact has no deployment detail", () => {
    expect(deploymentArtifactToInfo(makeDeploymentArtifact(null))).toBeNull();
  });

  it("maps the deployment detail onto the wire shape when present", () => {
    const result = deploymentArtifactToInfo(
      makeDeploymentArtifact({
        environment: "production",
        ref: "refs/heads/main",
        sha: "abc123",
        githubStatusUrl: "https://github.com/status",
        githubDeploymentUrl: "https://github.com/deployment",
        transient: false,
        production: true,
        branchArtifactId: "branch-1",
      })
    );

    expect(result).not.toBeNull();
    expect(result?.id).toBe("art-2");
    expect(result?.deployment).toEqual({
      environment: "production",
      ref: "refs/heads/main",
      sha: "abc123",
      githubStatusUrl: "https://github.com/status",
      githubDeploymentUrl: "https://github.com/deployment",
      transient: false,
      production: true,
      branchArtifactId: "branch-1",
    });
  });
});
