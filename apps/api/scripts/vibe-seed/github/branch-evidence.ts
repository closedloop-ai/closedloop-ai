import {
  BranchBaseBranchSource,
  BranchHeadShaSource,
  BranchPushSource,
} from "@repo/api/src/types/artifact";
import { BranchViewCheckKind } from "@repo/api/src/types/branch-check-projection";
import { BranchPushContributionSource } from "@repo/api/src/types/branch-push-contribution";
import { GitHubActorType } from "@repo/api/src/types/github-actor";
import { GitHubPRState } from "@repo/api/src/types/github-status";
import { Status } from "@repo/api/src/types/result";
import { withDb } from "@repo/database";
import type { StatusCheckRollupCheck } from "@repo/github";
import { recordBranchPushContribution } from "@/app/branches/branch-push-contribution-service";
import { branchService } from "@/app/branches/branch-service";
import { persistBranchFileChangeCache } from "@/app/branches/file-cache-service";
import { commitService } from "@/app/commits/commit-service";
import {
  GitHubBranchActivityAction,
  GitHubBranchActivityEventName,
} from "@/app/webhooks/github/handlers/branch-activity-producer";
import { persistBranchStatusChecksFromRollup } from "@/lib/branch-status-checks";
import { githubAppWebhookFetchProvenance } from "@/lib/github-fetch-provenance";
import type { VibeSeedContext } from "../stage";
import { deliverBranchActivity, seedDeliveryId } from "./branch-activity";
import { replayPullRequestWebhooks } from "./pull-request-projection";
import type { SeededBranch } from "./seeded-branches";
import type { BranchWork, GitHubPerson, WorkPush } from "./store-work";

/**
 * ISS-12017: replay a golden branch's GitHub side through the producers the
 * GitHub webhooks drive: each push (`branchService.upsertBranchArtifact`, the
 * push's commits through `commitService.recordWebhookCommits`, the pusher
 * through `recordBranchPushContribution`, and its push-LOC activity), the
 * compare-shaped file changes through `persistBranchFileChangeCache`, the head
 * commit's checks through `persistBranchStatusChecksFromRollup`, the pull
 * request's latest `pull_request` webhook projection, and its opened/closed
 * lifecycle activity.
 */

/** Jobs from this repository's own PR workflows (`pr-test.yml`, `e2e-test.yml`, the PR gates). */
const CHECK_NAMES = [
  "lint",
  "typecheck",
  "next-build",
  "storybook-build",
  "desktop-node",
  "desktop-renderer",
  "e2e-gate",
  "check-pr-body-sections",
  "ui-feature-flag-attestation",
] as const;
const VERCEL_CONTEXT = "Vercel";
const CHECK_RUN_DURATION_MS = 9 * 60 * 1000;

export async function replayBranchEvidence(
  context: VibeSeedContext,
  branch: SeededBranch,
  work: BranchWork
): Promise<void> {
  for (const push of work.pushes) {
    await replayPush(context, branch, work, push);
  }
  const head = work.pushes.at(-1);
  if (head === undefined) {
    return;
  }
  await persistBranchFileChangeCache({
    organizationId: context.organizationId,
    branchArtifactId: branch.artifactId,
    headSha: head.afterSha,
    files: work.files.map((file) => ({
      filename: file.path,
      status: file.status,
      additions: file.additions,
      deletions: file.deletions,
      changes: file.additions + file.deletions,
      patch: file.patch,
    })),
    capped: false,
    maxFileChanges: work.files.length,
  });
  await recordHeadChecks(context, branch, work, head);
  await replayPullRequestWebhooks(context, branch, work);
  await replayPullRequestLifecycle(context, branch, work);
}

async function replayPush(
  context: VibeSeedContext,
  branch: SeededBranch,
  work: BranchWork,
  push: WorkPush
): Promise<void> {
  const upsert = await branchService.upsertBranchArtifact({
    organizationId: context.organizationId,
    repositoryId: branch.repositoryId,
    repositoryFullName: branch.repositoryFullName,
    branchName: branch.branchName,
    projectId: branch.projectId,
    baseBranch: work.baseBranch,
    baseBranchSource: BranchBaseBranchSource.RepositoryDefault,
    headSha: push.afterSha,
    headShaSource: BranchHeadShaSource.PushWebhook,
    headShaObservedAt: push.at,
    activityAt: null,
    beforeSha: push.beforeSha,
    firstPushedAt: push.at,
    pushSource: BranchPushSource.Webhook,
    fetchProvenance: githubAppWebhookFetchProvenance(push.at),
  });
  if (!(upsert.ok || upsert.error === Status.Conflict)) {
    throw new Error(
      `push ${push.afterSha} to ${branch.branchName} was rejected: ${upsert.error}`
    );
  }
  const { commits } = push;
  await commitService.recordWebhookCommits({
    organizationId: context.organizationId,
    repositoryFullName: branch.repositoryFullName,
    branchArtifactId: branch.artifactId,
    commits: commits.map((commit) => ({
      sha: commit.sha,
      message: commit.message,
      committedAt: commit.committedAt,
      authoredAt: commit.committedAt,
      ...authorFields(work.author),
      linesAdded: commit.linesAdded,
      linesRemoved: commit.linesRemoved,
      filesChanged: commit.filesChanged,
    })),
  });
  const deliveryId = seedDeliveryId("push", branch.artifactId, push.afterSha);
  await recordBranchPushContribution({
    organizationId: context.organizationId,
    branchArtifactId: branch.artifactId,
    repositoryFullName: branch.repositoryFullName,
    refName: branch.branchName,
    beforeSha: push.beforeSha,
    afterSha: push.afterSha,
    source: BranchPushContributionSource.Webhook,
    sourceEventId: deliveryId,
    providerUserId: String(work.author.id),
    providerLogin: work.author.login,
    actorType: GitHubActorType.User,
    newCommitCount: commits.length,
    observedAt: push.at,
  });
  await deliverBranchActivity({
    eventName: GitHubBranchActivityEventName.Push,
    deliveryId,
    payload: {
      ref: `refs/heads/${branch.branchName}`,
      before: push.beforeSha,
      after: push.afterSha,
      commits: commits.map((commit) => ({
        id: commit.sha,
        timestamp: commit.committedAt.toISOString(),
      })),
    },
    attribution: {
      organizationId: context.organizationId,
      branchArtifactId: branch.artifactId,
    },
    pushLineDelta: {
      linesAdded: push.linesAdded,
      linesRemoved: push.linesRemoved,
    },
    pushBaseSha: push.beforeSha,
  });
}

/**
 * The head commit's checks as the GitHub `statusCheckRollup` reports them. An
 * open pull request's head can still be running or red; a settled branch's
 * head passed.
 */
async function recordHeadChecks(
  context: VibeSeedContext,
  branch: SeededBranch,
  work: BranchWork,
  head: WorkPush
): Promise<void> {
  const open = work.pullRequests.at(-1)?.facts.state === GitHubPRState.Open;
  const outcome = open ? Number.parseInt(head.afterSha.slice(0, 2), 16) % 4 : 3;
  const checks: StatusCheckRollupCheck[] = CHECK_NAMES.map(
    (name, position) => ({
      id: `${head.afterSha.slice(0, 12)}:${name}`,
      kind: BranchViewCheckKind.CheckRun,
      name,
      ...checkRunResult(name, outcome),
      targetUrl: `https://github.com/${branch.repositoryFullName}/actions/runs/${checkRunNumber(head.afterSha, position)}`,
      providerNodeId: null,
      position,
    })
  );
  checks.push({
    id: `${head.afterSha.slice(0, 12)}:${VERCEL_CONTEXT}`,
    kind: BranchViewCheckKind.StatusContext,
    name: VERCEL_CONTEXT,
    status: null,
    conclusion: "SUCCESS",
    targetUrl: null,
    providerNodeId: null,
    position: checks.length,
  });
  const persisted = await withDb.tx((tx) =>
    persistBranchStatusChecksFromRollup(tx, {
      branchArtifactId: branch.artifactId,
      organizationId: context.organizationId,
      headSha: head.afterSha,
      rollup: {
        ok: true,
        state: rollupState(outcome),
        checks,
        totalCount: checks.length,
        truncated: false,
      },
      fetchProvenance: githubAppWebhookFetchProvenance(head.at),
    })
  );
  if (persisted.status !== "updated") {
    throw new Error(
      `checks for ${branch.branchName} at ${head.afterSha} were not persisted: ${persisted.reason}`
    );
  }
  const completedAt = new Date(
    Math.min(head.at.getTime() + CHECK_RUN_DURATION_MS, context.now.getTime())
  );
  await deliverBranchActivity({
    eventName: GitHubBranchActivityEventName.CheckRun,
    deliveryId: seedDeliveryId("check_run", branch.artifactId, head.afterSha),
    payload: {
      action: GitHubBranchActivityAction.Completed,
      check_run: { completed_at: completedAt.toISOString() },
    },
    attribution: {
      organizationId: context.organizationId,
      branchArtifactId: branch.artifactId,
    },
  });
}

async function replayPullRequestLifecycle(
  context: VibeSeedContext,
  branch: SeededBranch,
  work: BranchWork
): Promise<void> {
  for (const pullRequest of work.pullRequests) {
    const detailId = branch.pullRequestIdsByNumber.get(pullRequest.number);
    if (detailId === undefined) {
      continue;
    }
    const attribution = {
      organizationId: context.organizationId,
      branchArtifactId: branch.artifactId,
      pullRequestDetailId: detailId,
    };
    await deliverBranchActivity({
      eventName: GitHubBranchActivityEventName.PullRequest,
      deliveryId: seedDeliveryId("pull_request", detailId, "opened"),
      payload: {
        action: GitHubBranchActivityAction.Opened,
        pull_request: { created_at: pullRequest.openedAt.toISOString() },
      },
      attribution,
    });
    const { closedAt, mergedAt, state } = pullRequest.facts;
    if (state === GitHubPRState.Open || closedAt === undefined) {
      continue;
    }
    await deliverBranchActivity({
      eventName: GitHubBranchActivityEventName.PullRequest,
      deliveryId: seedDeliveryId("pull_request", detailId, "closed"),
      payload: {
        action: GitHubBranchActivityAction.Closed,
        pull_request: {
          merged: state === GitHubPRState.Merged,
          merged_at: mergedAt ?? null,
          closed_at: closedAt,
        },
      },
      attribution,
    });
  }
}

function authorFields(person: GitHubPerson) {
  return {
    authorName: person.login,
    authorEmail: `${person.id}+${person.login}@users.noreply.github.com`,
    authorLogin: person.login,
  };
}

/** Outcome 0 fails `desktop-node`, 1 leaves `e2e-gate` running, 2 and 3 pass. */
function checkRunResult(
  name: (typeof CHECK_NAMES)[number],
  outcome: number
): { status: string; conclusion: string | null } {
  if (outcome === 0 && name === "desktop-node") {
    return { status: "COMPLETED", conclusion: "FAILURE" };
  }
  if (outcome === 1 && name === "e2e-gate") {
    return { status: "IN_PROGRESS", conclusion: null };
  }
  return { status: "COMPLETED", conclusion: "SUCCESS" };
}

function rollupState(outcome: number): "FAILURE" | "PENDING" | "SUCCESS" {
  if (outcome === 0) {
    return "FAILURE";
  }
  return outcome === 1 ? "PENDING" : "SUCCESS";
}

function checkRunNumber(sha: string, position: number): number {
  return 17_000_000_000 + Number.parseInt(sha.slice(0, 7), 16) + position;
}
