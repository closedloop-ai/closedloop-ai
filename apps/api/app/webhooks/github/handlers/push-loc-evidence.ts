import type { PushEvent } from "@octokit/webhooks-types";
import {
  compareBranchFileChangesWithProviderResult,
  type GitHubChangedFile,
  GitHubProviderResultStatus,
} from "@repo/github";
import { log } from "@repo/observability/log";
import { isGitHubZeroSha } from "@/app/branches/branch-state-transitions";
import { readWithInstallationClient } from "@/lib/github/installation-client";
import { isStorableInt4Count } from "@/lib/int4-column-bounds";
import {
  GitHubBranchActivityEventName,
  persistGitHubBranchActivity,
} from "./branch-activity-producer";

/**
 * Capture the per-push activity atom for one push delivery (ISS-10009).
 *
 * Never throws: a provider or database failure here must not fail branch
 * materialization or the webhook ack. The compare is skipped entirely for a
 * zero-commit push, because the producer writes no row for one (operator ruling
 * 1) and there is nothing to attach a delta to.
 */
export async function capturePushBranchActivity(input: {
  branchArtifactId: string;
  deliveryId: string | undefined;
  event: PushEvent;
  installationId: string;
  organizationId: string;
}): Promise<void> {
  try {
    const compare =
      input.event.commits.length === 0
        ? UNMEASURED_PUSH_COMPARE
        : await resolvePushCompare({
            afterSha: input.event.after,
            // A branch create sends the zero sha as `before`, and comparing
            // against it is a guaranteed 404 — which would leave the FIRST push
            // of every branch permanently unmeasurable. The repository default
            // is the base the branch's own file cache already measures against,
            // and on a create it bounds exactly the commits this push carried.
            baseRef: isGitHubZeroSha(input.event.before)
              ? input.event.repository.default_branch
              : input.event.before,
            installationId: input.installationId,
            owner: input.event.repository.owner.login,
            repo: input.event.repository.name,
          });
    await persistGitHubBranchActivity({
      attribution: {
        branchArtifactId: input.branchArtifactId,
        organizationId: input.organizationId,
      },
      deliveryId: input.deliveryId,
      eventName: GitHubBranchActivityEventName.Push,
      payload: input.event,
      pushBaseSha: compare.baseSha,
      pushLineDelta: compare.lineDelta,
    });
  } catch (error) {
    log.warn("[capturePushBranchActivity] Push activity capture failed", {
      branchArtifactId: input.branchArtifactId,
      error: error instanceof Error ? error.message : String(error),
      organizationId: input.organizationId,
    });
  }
}

type PushLineDelta = { linesAdded: number; linesRemoved: number };

/**
 * What the compare measured: the immutable base the totals belong to, and the
 * totals themselves. The two travel together because a delta persisted under a
 * range it was not computed over is worse than no delta at all — part 2
 * attributes per-push contributions BY that range.
 */
type PushCompare = {
  baseSha: string | undefined;
  lineDelta: PushLineDelta | null;
};

/** No compare was read, so neither the range nor the totals are known. */
const UNMEASURED_PUSH_COMPARE: PushCompare = {
  baseSha: undefined,
  lineDelta: null,
};

/**
 * The push's own compared base and line delta; either is null/undefined when
 * UNKNOWN.
 *
 * The base returned is the provider's `merge_base_commit`, NOT `baseRef`. On a
 * branch create `baseRef` is the repository default — a moving ref that can
 * advance between this deferred read and the write — so storing the payload's
 * `before` (all zeros on a create) or the ref name would describe a different
 * range than the totals. The merge base is the commit the returned diff was
 * actually computed from, whatever the ref did afterwards, and on a force-push
 * it is likewise the real base rather than the abandoned `before` tip.
 *
 * `compareBranchFileChangesWithProviderResult` issues ONE request and changed
 * files appear only on that first response (ISS-6127), so a push touching more
 * files than the provider's ceiling comes back capped with each returned row
 * individually complete — the sum is confident and short. A failed compare and
 * an empty file list are the same unknown: the helper collapses a missing
 * `files` key into `[]`, so zero files cannot be told apart from a response that
 * withheld the field. All three take the exit `currentFileTotals`
 * (`app/branches/branch-loc.ts`) already takes for a capped file cache.
 */
async function resolvePushCompare(input: {
  afterSha: string;
  baseRef: string;
  installationId: string;
  owner: string;
  repo: string;
}): Promise<PushCompare> {
  const compared = await readWithInstallationClient(
    input.installationId,
    (octokit) =>
      compareBranchFileChangesWithProviderResult(
        octokit,
        input.owner,
        input.repo,
        input.baseRef,
        input.afterSha
      )
  );
  if (compared.status !== GitHubProviderResultStatus.Success) {
    return UNMEASURED_PUSH_COMPARE;
  }
  const { capped, files, mergeBaseSha } = compared.value;
  return {
    baseSha: mergeBaseSha,
    lineDelta: capped || files.length === 0 ? null : sumChangedFileLines(files),
  };
}

/**
 * Fold the compare's per-file counts, refusing the whole sum if any file's
 * counts — or the total — are not storable ones. These cross a provider
 * boundary that no schema guards, and the bound is the `int4` column's, not
 * JavaScript's: a sum past `int4` passes a safe-integer check, then raises a
 * numeric-overflow this module's own catch would swallow, dropping the atom's
 * timestamp and shas along with it. Unknown is a null delta, never a lost row.
 */
function sumChangedFileLines(
  files: readonly GitHubChangedFile[]
): PushLineDelta | null {
  let linesAdded = 0;
  let linesRemoved = 0;
  for (const file of files) {
    if (
      !(
        isStorableInt4Count(file.additions) &&
        isStorableInt4Count(file.deletions)
      )
    ) {
      return null;
    }
    linesAdded += file.additions;
    linesRemoved += file.deletions;
  }
  return isStorableInt4Count(linesAdded) && isStorableInt4Count(linesRemoved)
    ? { linesAdded, linesRemoved }
    : null;
}
