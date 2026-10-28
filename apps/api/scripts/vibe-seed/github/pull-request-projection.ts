import type { PullRequest } from "@octokit/webhooks-types";
import { GitHubActorType } from "@repo/api/src/types/github-actor";
import { GitHubPRState } from "@repo/api/src/types/github-status";
import { vibeSeedPullRequestTopic } from "@repo/api/src/vibe-seed-corpus";
import { withDb } from "@repo/database";
import { GitHubBranchActivityAction } from "@/app/webhooks/github/handlers/branch-activity-producer";
import { writeExistingWebhookPullRequestProjection } from "@/app/webhooks/github/handlers/pull-request-projection";
import type { VibeSeedContext } from "../stage";
import { seedDeliveryId } from "./branch-activity";
import type { SeededBranch } from "./seeded-branches";
import type { BranchWork, WorkPullRequest } from "./store-work";

/**
 * ISS-12017: deliver each golden pull request's latest `pull_request` webhook
 * payload to `writeExistingWebhookPullRequestProjection`, the write the
 * `pull_request` handler makes for a PR it already holds. The Desktop ingest
 * created the row from the session's refs; this fills what only GitHub knows:
 * the author, head commit, body, and opened/merged times.
 */
export async function replayPullRequestWebhooks(
  context: VibeSeedContext,
  branch: SeededBranch,
  work: BranchWork
): Promise<void> {
  const head = work.pushes.at(-1);
  const { repositoryId, repositoryGitHubId } = branch;
  if (
    head === undefined ||
    repositoryId === null ||
    repositoryGitHubId === null
  ) {
    return;
  }
  const stored = await context.prisma.branchDetail.findFirst({
    where: {
      artifactId: branch.artifactId,
      organizationId: context.organizationId,
    },
    select: { checksStatus: true, headSha: true },
  });
  for (const pullRequest of work.pullRequests) {
    const pullRequestDetailId = branch.pullRequestIdsByNumber.get(
      pullRequest.number
    );
    if (pullRequestDetailId === undefined) {
      continue;
    }
    const settled = pullRequest.facts.state !== GitHubPRState.Open;
    await withDb.tx((tx) =>
      writeExistingWebhookPullRequestProjection(
        tx,
        {
          branchArtifactId: branch.artifactId,
          checksStatus: stored?.checksStatus,
          currentHeadSha: stored?.headSha ?? null,
          organizationId: context.organizationId,
          pullRequestDetailId,
          repositoryId,
          repositoryFullName: branch.repositoryFullName,
          hasBranchArtifact: true,
        },
        webhookPullRequest(branch, work, pullRequest, {
          headSha: head.afterSha,
          repositoryGitHubId,
        }),
        settled
          ? GitHubBranchActivityAction.Closed
          : GitHubBranchActivityAction.Edited,
        {
          deliveryId: seedDeliveryId(
            "pull_request",
            pullRequestDetailId,
            "latest"
          ),
          observedAt: context.now,
        }
      )
    );
  }
}

/**
 * The subset of a GitHub `pull_request` payload the projection reads. A
 * webhook's object carries ~60 more fields (labels, assignees, links) that no
 * column takes, so the literal is typed to the payload by assertion.
 */
function webhookPullRequest(
  branch: SeededBranch,
  work: BranchWork,
  pullRequest: WorkPullRequest,
  head: { headSha: string; repositoryGitHubId: number }
): PullRequest {
  const { facts } = pullRequest;
  const [owner = "", name = ""] = branch.repositoryFullName.split("/");
  const body = pullRequestBody(work);
  const updatedAt = facts.closedAt ?? work.pushes.at(-1)?.at.toISOString();
  const repository = {
    id: head.repositoryGitHubId,
    full_name: branch.repositoryFullName,
    name,
    owner: { login: owner },
    default_branch: work.baseBranch,
  };
  return {
    id: 2_100_000_000 + pullRequest.number,
    number: pullRequest.number,
    title: facts.title,
    body: body.length > 0 ? body : null,
    html_url: `https://github.com/${branch.repositoryFullName}/pull/${pullRequest.number}`,
    state: facts.state === GitHubPRState.Open ? "open" : "closed",
    merged: facts.state === GitHubPRState.Merged,
    draft: facts.isDraft,
    additions: facts.additions ?? 0,
    deletions: facts.deletions ?? 0,
    changed_files: facts.changedFiles ?? 0,
    created_at: pullRequest.openedAt.toISOString(),
    updated_at: updatedAt ?? pullRequest.openedAt.toISOString(),
    closed_at: facts.closedAt ?? null,
    merged_at: facts.mergedAt ?? null,
    merge_commit_sha: null,
    user: {
      id: work.author.id,
      login: work.author.login,
      type: GitHubActorType.User,
    },
    head: { ref: branch.branchName, sha: head.headSha, repo: repository },
    base: { ref: facts.baseRef, repo: repository },
  } as PullRequest;
}

/**
 * ISS-12135: the body the corpus session wrote for the branch's pull request
 * (`vibe-seed-corpus-topics.ts`), else the first commit's body.
 */
export function pullRequestBody(work: BranchWork): string {
  const topic = vibeSeedPullRequestTopic(work.branchName);
  if (topic !== undefined) {
    return topic.body;
  }
  const firstCommit = work.commits[0]?.message ?? "";
  return firstCommit.split("\n").slice(1).join("\n").trim();
}
