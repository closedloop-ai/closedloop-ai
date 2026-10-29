import {
  type DesktopGithubPullRequestLabels,
  labelResponseFields,
} from "@repo/api/src/types/desktop-github-pull-request";
import type { PullRequestLabelSpec } from "@repo/api/src/types/pull-request-label";
import {
  type PullRequestLabelSyncResult,
  PullRequestLabelSyncStatus,
} from "@repo/api/src/types/pull-request-label-sync-status";
import { reconcilePullRequestLabels } from "@repo/github/pull-request-labels";
import type { Octokit } from "@repo/github/user-token-auth";
import { log } from "@repo/observability/log";

type GithubRepository = {
  owner: string;
  repo: string;
};

const LOG_PREFIX = "[desktop/github/pull-request]";

export async function resolveLabelFields(
  octokit: Octokit,
  repository: GithubRepository,
  pullNumber: number,
  labels: readonly PullRequestLabelSpec[]
): Promise<DesktopGithubPullRequestLabels | undefined> {
  if (labels.length === 0) {
    return undefined;
  }
  try {
    const result = await reconcilePullRequestLabels(
      octokit,
      {
        ...repository,
        pullNumber,
      },
      labels
    );
    return labelFieldsForSyncResult(labels, result);
  } catch (error) {
    log.warn(`${LOG_PREFIX} Pull request label sync threw`, {
      owner: repository.owner,
      repo: repository.repo,
      pullNumber,
      error: error instanceof Error ? error.message : String(error),
    });
    return labelResponseFields(labels, [], []);
  }
}

function labelFieldsForSyncResult(
  labels: readonly PullRequestLabelSpec[],
  result: PullRequestLabelSyncResult
): DesktopGithubPullRequestLabels | undefined {
  const allRequestedNames = labels.map((label) => label.name);
  const appliedNames =
    result.status === PullRequestLabelSyncStatus.Applied ||
    result.status === PullRequestLabelSyncStatus.NoOp
      ? allRequestedNames
      : (result.knownAppliedLabels ?? result.addedLabels);
  return labelResponseFields(labels, result.droppedLabels, appliedNames);
}
