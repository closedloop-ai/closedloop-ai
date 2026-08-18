import "server-only";

import {
  SelectedPullRequestEvidenceAvailability,
  type SelectedPullRequestEvidenceResult,
  SelectedPullRequestEvidenceUnavailableReason,
} from "@repo/api/src/types/selected-pull-request-evidence";
import { z } from "zod";
import type { SelectedPullRequestOctokit } from "./selected-pull-request-client";
import { classifySelectedPullRequestProviderFailure } from "./selected-pull-request-provider-failure";

const GIT_SHA_REGEX = /^[0-9a-f]{40}$/i;

const pullRequestComparisonSchema = z.object({
  merge_base_commit: z.object({ sha: z.string().nullish() }),
});

type AvailableMergeBase = {
  status: typeof SelectedPullRequestEvidenceAvailability.Available;
  value: string;
};

type MergeBaseResult =
  | AvailableMergeBase
  | Exclude<
      SelectedPullRequestEvidenceResult,
      { status: typeof SelectedPullRequestEvidenceAvailability.Available }
    >;

/**
 * Resolve the immutable merge base used by GitHub's three-dot PR comparison,
 * propagating caller cancellation without provider-failure classification.
 */
export async function readSelectedPullRequestMergeBase(
  octokit: SelectedPullRequestOctokit,
  owner: string,
  repo: string,
  baseTipSha: string,
  headSha: string,
  signal: AbortSignal
): Promise<MergeBaseResult> {
  signal.throwIfAborted();
  try {
    const response = await octokit.rest.repos.compareCommitsWithBasehead({
      owner,
      repo,
      basehead: `${baseTipSha}...${headSha}`,
      request: { signal },
    });
    signal.throwIfAborted();
    const parsed = pullRequestComparisonSchema.safeParse(response.data);
    const mergeBaseSha = parsed.success
      ? (parsed.data.merge_base_commit.sha?.trim() ?? "")
      : "";
    if (!GIT_SHA_REGEX.test(mergeBaseSha)) {
      return missingImmutableRevision();
    }
    return {
      status: SelectedPullRequestEvidenceAvailability.Available,
      value: mergeBaseSha,
    };
  } catch (error) {
    if (signal.aborted) {
      throw signal.reason;
    }
    const classified = classifySelectedPullRequestProviderFailure(error);
    return classified;
  }
}

function missingImmutableRevision(): Exclude<
  SelectedPullRequestEvidenceResult,
  { status: typeof SelectedPullRequestEvidenceAvailability.Available }
> {
  return {
    status: SelectedPullRequestEvidenceAvailability.Unavailable,
    reason:
      SelectedPullRequestEvidenceUnavailableReason.MissingImmutableRevision,
  };
}
