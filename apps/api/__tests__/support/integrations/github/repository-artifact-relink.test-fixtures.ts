/**
 * Fake transaction client and result builders for driving
 * `runRepositoryArtifactRelink` directly (ISS-11280). Consumers must mock
 * `@repo/database` (`createDatabaseMockModule`) so `withDb.tx` routes here.
 */

import { GitHubInstallationStatus } from "@repo/database";
import { type Mock, vi } from "vitest";
import { mockWithDbTx } from "@/__tests__/utils/db-helpers";
import {
  type RepositoryRelinkCandidate,
  runRepositoryArtifactRelink,
} from "@/app/integrations/github/service/repository-artifact-relink";
import {
  RepositoryArtifactRelinkFailureStage,
  RepositoryArtifactRelinkReason,
  type RepositoryArtifactRelinkResult,
  RepositoryArtifactRelinkStatus,
} from "@/app/integrations/github/service/repository-relink-telemetry";

export const ORG_ID = "org-1";
export const OTHER_ORG_ID = "org-2";
export const INSTALLATION_ID = "install-active";
export const ACTIVE_REPO_ID = "repo-active";
export const STALE_REPO_ID = "repo-stale";
export const GITHUB_REPO_ID = "gh-101";
export const BRANCH_ID = "branch-artifact-1";

export type StaleBranch = {
  artifactId: string;
  branchName: string;
  currentPullRequestDetailId: string | null;
};
export type StalePrDetail = { id: string; isCurrent: boolean; number: number };
export type ActivePrCollision = {
  id: string;
  number: number;
  branchArtifactId: string;
  branchArtifact: { organizationId: string };
};

export type RelinkTxOptions = {
  staleRepositories?: RepositoryRelinkCandidate[];
  staleBranches?: StaleBranch[];
  validPointerId?: string | null;
  stalePrDetails?: StalePrDetail[];
  activePrCollisions?: ActivePrCollision[];
  setCurrentCount?: number;
};

export function activeCandidate(
  overrides: Partial<RepositoryRelinkCandidate> = {}
): RepositoryRelinkCandidate {
  return {
    id: ACTIVE_REPO_ID,
    githubRepoId: GITHUB_REPO_ID,
    fullName: "acme/widgets",
    ...overrides,
  };
}

export function staleBranch(overrides: Partial<StaleBranch> = {}): StaleBranch {
  return {
    artifactId: BRANCH_ID,
    branchName: "feature/relink",
    currentPullRequestDetailId: null,
    ...overrides,
  };
}

export function relinkResult(
  overrides: Partial<RepositoryArtifactRelinkResult>
): RepositoryArtifactRelinkResult {
  return {
    status: RepositoryArtifactRelinkStatus.Skipped,
    reasons: [RepositoryArtifactRelinkReason.None],
    activeRepositoryCount: 1,
    staleRepositoryCount: 0,
    branchRelinkedCount: 0,
    pullRequestRelinkedCount: 0,
    branchCollisionSkippedCount: 0,
    pullRequestCollisionSkippedCount: 0,
    ambiguousRepositorySkippedCount: 0,
    blockedBranchCount: 0,
    ...overrides,
  };
}

/**
 * A transaction fake that answers each read by the repository (or pointer id)
 * the production query actually put in its `where`, so a query that drops the
 * repository term reads the wrong population instead of passing by accident.
 */
export type RelinkTx = {
  gitHubInstallation: { findFirst: Mock };
  gitHubInstallationRepository: { findMany: Mock };
  branchDetail: { findMany: Mock; update: Mock };
  pullRequestDetail: {
    findFirst: Mock;
    findMany: Mock;
    update: Mock;
    updateMany: Mock;
  };
};

export function createRelinkTx(options: RelinkTxOptions = {}): RelinkTx {
  const tx: RelinkTx = {
    gitHubInstallation: {
      findFirst: vi.fn().mockResolvedValue({
        organizationId: ORG_ID,
        status: GitHubInstallationStatus.ACTIVE,
      }),
    },
    gitHubInstallationRepository: {
      findMany: vi.fn().mockResolvedValue(
        options.staleRepositories ?? [
          {
            id: STALE_REPO_ID,
            githubRepoId: GITHUB_REPO_ID,
            fullName: "acme/widgets",
          },
        ]
      ),
    },
    branchDetail: {
      findMany: vi.fn(({ where }: { where: { repositoryId: string } }) =>
        Promise.resolve(
          where.repositoryId === STALE_REPO_ID
            ? (options.staleBranches ?? [staleBranch()])
            : []
        )
      ),
      update: vi.fn().mockResolvedValue({ artifactId: BRANCH_ID }),
    },
    pullRequestDetail: {
      findFirst: vi.fn(({ where }: { where: { id: string } }) =>
        Promise.resolve(
          where.id === options.validPointerId ? { id: where.id } : null
        )
      ),
      findMany: vi.fn(({ where }: { where: { repositoryId: string } }) =>
        Promise.resolve(
          where.repositoryId === ACTIVE_REPO_ID
            ? (options.activePrCollisions ?? [])
            : (options.stalePrDetails ?? [])
        )
      ),
      update: vi.fn().mockResolvedValue({ id: "pr" }),
      updateMany: vi.fn(({ where }: { where: { id?: unknown } }) =>
        Promise.resolve({
          count:
            typeof where.id === "string" ? (options.setCurrentCount ?? 1) : 0,
        })
      ),
    },
  };
  mockWithDbTx(tx);
  return tx;
}

export function branchRelinkWrite(currentPullRequestDetailId: string | null) {
  return {
    where: { artifactId: BRANCH_ID },
    data: { currentPullRequestDetailId, repositoryId: ACTIVE_REPO_ID },
    select: { artifactId: true },
  };
}

export function runRelink(repositories: RepositoryRelinkCandidate[]) {
  return runRepositoryArtifactRelink({
    installationId: INSTALLATION_ID,
    repositories,
    failureStage: RepositoryArtifactRelinkFailureStage.SyncRepositories,
  });
}
