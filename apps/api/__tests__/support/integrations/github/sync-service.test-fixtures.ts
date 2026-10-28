import { SessionArtifactLinkKind } from "@repo/api/src/types/session-artifact-link";
import type { GitHubSinglePullRequestResult } from "@repo/github";
import { type Mock, vi } from "vitest";

export const organizationId = "org-1";
export const branchArtifactId = "branch-1";
export const actorUserId = "019fed13-b752-77c3-bf22-0a6c655d4a38";
export const now = new Date("2026-07-06T09:00:00.000Z");

export function createMockDb(): {
  artifact: { findFirst: Mock };
  artifactLink: { findFirst: Mock };
  branchDetail: { updateMany: Mock };
  gitHubUserConnection: { findUnique: Mock; updateMany: Mock };
  pullRequestDetail: { findFirst: Mock; updateMany: Mock };
  repositoryDefaultObservationReceipt: { createMany: Mock };
  user: { findUnique: Mock };
} {
  return {
    artifact: {
      findFirst: vi.fn(),
    },
    artifactLink: {
      findFirst: vi.fn(),
    },
    branchDetail: {
      updateMany: vi.fn(),
    },
    gitHubUserConnection: {
      findUnique: vi.fn(),
      updateMany: vi.fn(),
    },
    pullRequestDetail: {
      findFirst: vi.fn().mockResolvedValue(null),
      updateMany: vi.fn(),
    },
    repositoryDefaultObservationReceipt: {
      createMany: vi.fn(),
    },
    // PLN-1742: the Clerk lane reads the caller's Clerk id off the user row.
    user: {
      findUnique: vi.fn().mockResolvedValue({ clerkId: "c_1" }),
    },
  };
}

/**
 * One owned PR row in the shape the branch-canonical arbitration reads. Live,
 * fact-carrying and provider-authoritative unless a case says otherwise.
 */
export function makePullRequestDetailRow(
  overrides: Partial<{
    id: string;
    number: number;
    githubId: string | null;
    fetchMechanism: string | null;
    prState: string;
    mergedAt: Date | null;
    additions: number | null;
    title: string | null;
    repositoryId: string | null;
    repositoryFullName: string;
    repository: {
      fullName: string;
      githubRepoId?: string;
      removedAt?: Date | null;
    };
  }> = {}
) {
  return {
    id: "pr-detail-1",
    branchArtifactId,
    repositoryId: "repo-1",
    repositoryFullName: "closedloop-ai/closedloop-ai",
    repository: {
      fullName: "closedloop-ai/closedloop-ai",
      // ISS-8901: the provider identity ownership probes first. Equal to the
      // branch's by default, so a case that means to model a FOREIGN repository
      // has to say so — the surrogate `repositoryId` no longer decides.
      githubRepoId: "gh-repo-1",
      removedAt: new Date("2026-07-06T08:30:00.000Z"),
    },
    number: 2294,
    title: "FEA-2605",
    htmlUrl: "https://github.com/closedloop-ai/closedloop-ai/pull/2294",
    prState: "OPEN",
    isDraft: false,
    reviewDecision: null,
    githubCreatedAt: new Date("2026-08-01T00:00:00.000Z"),
    closedAt: null,
    mergedAt: null,
    lastVerifiedAt: new Date("2026-08-02T00:00:00.000Z"),
    fetchMechanism: "webhook",
    githubId: "github-pr-1",
    additions: 5,
    deletions: 2,
    changedFiles: 1,
    ...overrides,
  };
}

export function makeBranchTarget(
  overrides: {
    currentPullRequestDetailId?: string | null;
    pullRequestDetails?: ReturnType<typeof makePullRequestDetailRow>[];
    installationStatus?: string;
    private?: boolean;
    removedAt?: Date | null;
  } = {}
) {
  return {
    id: branchArtifactId,
    organizationId,
    pullRequestDetails: overrides.pullRequestDetails ?? [
      makePullRequestDetailRow(),
    ],
    branch: {
      repositoryId: "repo-1",
      repositoryFullName: "closedloop-ai/closedloop-ai",
      currentPullRequestDetailId:
        overrides.currentPullRequestDetailId === undefined
          ? "pr-detail-1"
          : overrides.currentPullRequestDetailId,
      repository: {
        id: "repo-1",
        fullName: "closedloop-ai/closedloop-ai",
        githubRepoId: "gh-repo-1",
        owner: "closedloop-ai",
        name: "closedloop-ai",
        private: overrides.private ?? true,
        removedAt: resolveRemovedAt(overrides.removedAt),
        installation: {
          organizationId,
          status: overrides.installationStatus ?? "ACTIVE",
        },
      },
    },
  };
}

export function makeSessionPrLink() {
  return {
    metadata: {
      linkKind: SessionArtifactLinkKind.SessionPr,
      repositoryFullName: "closedloop-ai/closedloop-ai",
      prNumber: 2294,
    },
  };
}

export function makeUserConnection(
  overrides: {
    revokedAt?: Date | null;
    scopes?: string[];
    tokenExpiresAt?: Date | null;
  } = {}
) {
  return {
    id: "connection-1",
    organizationId,
    userId: actorUserId,
    githubUserId: "9001",
    login: "octocat",
    revokedAt: overrides.revokedAt ?? null,
    tokenExpiresAt: overrides.tokenExpiresAt ?? null,
    scopes: overrides.scopes ?? ["repo"],
    rateLimitTier: null,
    // PLN-1742 M2: this lane shares the resolver's connection read, which
    // samples `lastUsedAt` — so the row it selects carries it.
    lastUsedAt: null,
  };
}

export function makeProviderPullRequest(
  overrides: Partial<GitHubSinglePullRequestResult> = {}
): GitHubSinglePullRequestResult {
  return {
    githubId: "github-pr-1",
    number: 2294,
    title: "FEA-2605",
    htmlUrl: "https://github.com/closedloop-ai/closedloop-ai/pull/2294",
    headBranch: "feat/fea-2605-github-provenance",
    baseBranch: "main",
    state: "MERGED",
    createdAt: "2026-07-06T09:00:00.000Z",
    mergedAt: "2026-07-06T10:00:00.000Z",
    closedAt: "2026-07-06T10:00:00.000Z",
    authorLogin: "davetho",
    isDraft: false,
    headSha: "head-sha",
    baseSha: "base-sha",
    mergeCommitSha: "merge-sha",
    additions: 33,
    deletions: 7,
    changedFiles: 4,
    ...overrides,
  };
}

function resolveRemovedAt(value: Date | null | undefined): Date | null {
  if (value === undefined) {
    return new Date("2026-07-06T08:30:00.000Z");
  }
  return value;
}
