import { normalizeRepoFullName } from "@repo/api/src/types/branch";
import { type TransactionClient, withDb } from "@repo/database";
import { parseError } from "@repo/observability/error";
import { log } from "@repo/observability/log";
import {
  BranchMaterializationStatus,
  ensureBranchArtifactRow,
} from "@/app/agent-sessions/service/artifact-links/branch-links";
import { resolveRepositoryAuthorityByNames } from "@/app/agent-sessions/service/artifact-links/shared";
import { seedBranchOwners } from "./branch-owner-seed/branch-owner-seed";
import { relinkPullRequestBranchInTransaction } from "./pull-request-branch-relink";
import {
  type GitHubPullRequestHeadRead,
  needsGitHubHeadRefile,
  type PullRequestFiling,
  type PullRequestGitHubHead,
  pullRequestGitHubHead,
} from "./pull-request-github-head-filing";
import {
  acquirePullRequestProviderIdentityLockInTransaction,
  pullRequestProviderLockTxOptions,
} from "./pull-request-provider-lock";

type RefileInput = {
  organizationId: string;
  pullRequestDetailId: string;
  head: PullRequestGitHubHead;
};

type FiledPullRequest = PullRequestFiling & {
  number: number;
  projectId: string | null;
  githubUpdatedAt: Date | null;
};

/**
 * ISS-12344, Perrin Upcott's ruling 2026-10-09 ("Move it"; decision record in
 * comment thread th_1__bTDiF9jNPx9ebLHmn0): when the Branch a PR is filed under
 * disagrees with the head GitHub reports, the PR is re-filed under GitHub's
 * head. GitHub is the authority, whichever client filed the row.
 *
 * Runs after a GitHub read has committed, in its own transaction.
 */
export async function refilePullRequestUnderGitHubHead(
  organizationId: string,
  pullRequestDetailId: string,
  read: GitHubPullRequestHeadRead
): Promise<boolean> {
  const input: RefileInput = {
    organizationId,
    pullRequestDetailId,
    head: pullRequestGitHubHead(read),
  };
  try {
    return await withDb.tx(
      (tx) => refileInTransaction(tx, input, true),
      pullRequestProviderLockTxOptions
    );
  } catch (error) {
    // Isolated, like the reconciler's head-authority write: the GitHub read
    // already landed, and the next read of this PR retries the move.
    log.error("pull_request_github_head_refile_failed", {
      organizationId: input.organizationId,
      pullRequestDetailId: input.pullRequestDetailId,
      error: parseError(error),
    });
    return false;
  }
}

/**
 * The in-transaction move, for the `pull_request` webhook. It moves the PR only
 * onto a head Branch that already exists. Creating one here could lose a unique
 * race to a desktop session lane, which does not hold this PR's provider lock,
 * and the P2002 would abort the whole delivery. A missing head Branch is left
 * to the reconciler and the Branch refreshes, which create it in their own
 * transaction.
 */
export function refilePullRequestUnderGitHubHeadInTransaction(
  tx: TransactionClient,
  input: RefileInput
): Promise<boolean> {
  return refileInTransaction(tx, input, false);
}

/**
 * The unlocked read settles the common case (already filed under its head)
 * without the lock; the move re-checks under the PR-provider lock before it
 * writes.
 */
async function refileInTransaction(
  tx: TransactionClient,
  input: RefileInput,
  createWhenAbsent: boolean
): Promise<boolean> {
  const identity = await readFiledPullRequest(tx, input);
  if (
    !(
      identity?.repositoryFullName &&
      needsGitHubHeadRefile(identity, input.head)
    )
  ) {
    return false;
  }
  const repositoryFullName = normalizeRepoFullName(identity.repositoryFullName);
  await acquirePullRequestProviderIdentityLockInTransaction(tx, {
    organizationId: input.organizationId,
    repositoryFullName,
    number: identity.number,
  });
  const filed = await readFiledPullRequest(tx, input);
  if (
    !(filed && needsGitHubHeadRefile(filed, input.head)) ||
    storedRowIsNewer(filed, input.head)
  ) {
    return false;
  }
  const authorities = await resolveRepositoryAuthorityByNames(
    tx,
    input.organizationId,
    [repositoryFullName]
  );
  const target = await ensureBranchArtifactRow(tx, {
    organizationId: input.organizationId,
    projectId: filed.projectId,
    repositoryAuthority: authorities.get(repositoryFullName),
    repositoryFullName,
    branchName: input.head.branchName,
    createWhenAbsent,
  });
  if (target.status === BranchMaterializationStatus.NotMaterialized) {
    log.warn("pull_request_github_head_refile_not_materialized", {
      organizationId: input.organizationId,
      pullRequestDetailId: input.pullRequestDetailId,
      cause: target.cause,
    });
    return false;
  }
  const moved = await relinkPullRequestBranchInTransaction(tx, {
    organizationId: input.organizationId,
    pullRequestDetailId: input.pullRequestDetailId,
    branchArtifactId: target.artifactId,
    repositoryFullName,
    pullRequestNumber: identity.number,
  });
  if (moved) {
    // ISS-12463: the moved PR's creator is new evidence for its head Branch.
    await seedBranchOwners(tx, input.organizationId, [target.artifactId]);
  }
  return moved;
}

/**
 * The stored row came from a newer GitHub read than this caller's: a webhook
 * relink after a rename, say, already decided where the PR lives, so a caller
 * holding the older head must not move it back. A read without a timestamp
 * cannot show it is the newer one, so it moves nothing either.
 */
function storedRowIsNewer(
  filed: FiledPullRequest,
  head: PullRequestGitHubHead
): boolean {
  if (filed.githubUpdatedAt === null) {
    return false;
  }
  return (
    head.updatedAt === null ||
    filed.githubUpdatedAt.getTime() > head.updatedAt.getTime()
  );
}

async function readFiledPullRequest(
  db: Pick<TransactionClient, "pullRequestDetail">,
  input: RefileInput
): Promise<FiledPullRequest | null> {
  const row = await db.pullRequestDetail.findFirst({
    where: {
      id: input.pullRequestDetailId,
      organizationId: input.organizationId,
    },
    select: {
      number: true,
      repositoryFullName: true,
      githubUpdatedAt: true,
      repository: { select: { fullName: true } },
      branchArtifact: {
        select: {
          projectId: true,
          branch: { select: { branchName: true, repositoryFullName: true } },
        },
      },
    },
  });
  if (!row) {
    return null;
  }
  return {
    number: row.number,
    repositoryFullName:
      row.repositoryFullName ?? row.repository?.fullName ?? null,
    branch: row.branchArtifact.branch,
    projectId: row.branchArtifact.projectId,
    githubUpdatedAt: row.githubUpdatedAt,
  };
}
