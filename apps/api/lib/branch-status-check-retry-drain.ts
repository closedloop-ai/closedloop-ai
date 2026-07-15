import { StatusCheckRollupFailureReason } from "@repo/api/src/types/github";
import { GitHubFetchTrigger } from "@repo/api/src/types/github-read-model";
import { withDb } from "@repo/database";
import {
  GitHubProviderResultStatus,
  queryStatusCheckRollupWithProviderResult,
} from "@repo/github";
import {
  type CheckRunRetryClaim,
  claimDueCheckRunRetries,
  clearCheckRunRetry,
  discardCheckRunRetry,
  settleRetryableCheckRunFailure,
} from "@/lib/branch-status-check-retry";
import { persistBranchStatusChecksFromRollup } from "@/lib/branch-status-checks";
import { githubAppGraphqlFetchProvenance } from "@/lib/github-fetch-provenance";

export type CheckRunRetryDrainSummary = {
  claimed: number;
  succeeded: number;
  rescheduled: number;
  deadLettered: number;
  discarded: number;
  missing: number;
};

/**
 * Drain due check-run retry rows. Claims happen in a short transaction, GitHub
 * calls run outside database transactions, and each result is settled in a
 * fresh transaction so a failed provider call cannot poison the claim write.
 */
export async function drainDueCheckRunRetries(
  now = new Date(),
  limit = 25
): Promise<CheckRunRetryDrainSummary> {
  const claims = await withDb.tx((tx) =>
    claimDueCheckRunRetries(tx, now, limit)
  );
  const summary = emptyDrainSummary(claims.length);

  for (const claim of claims) {
    const providerResult = await queryStatusCheckRollupWithProviderResult(
      claim.installationId,
      claim.owner,
      claim.repo,
      claim.headSha
    );

    if (providerResult.status === GitHubProviderResultStatus.Success) {
      await settleSuccessfulProviderResult(
        claim,
        providerResult.value,
        summary
      );
      continue;
    }

    const retryAfterSeconds =
      providerResult.status === GitHubProviderResultStatus.ProviderRateLimit
        ? providerResult.retryAfterSeconds
        : null;
    const reason =
      providerResult.status === GitHubProviderResultStatus.ProviderRateLimit
        ? StatusCheckRollupFailureReason.RateLimited
        : StatusCheckRollupFailureReason.GraphqlError;
    await settleFailedProviderResult(
      claim,
      reason,
      retryAfterSeconds,
      now,
      summary
    );
  }

  return summary;
}

async function settleSuccessfulProviderResult(
  claim: CheckRunRetryClaim,
  rollup: Parameters<typeof persistBranchStatusChecksFromRollup>[1]["rollup"],
  summary: CheckRunRetryDrainSummary
): Promise<void> {
  await withDb.tx(async (tx) => {
    const result = await persistBranchStatusChecksFromRollup(tx, {
      branchArtifactId: claim.branchArtifactId,
      organizationId: claim.organizationId,
      headSha: claim.headSha,
      rollup,
      fetchProvenance: githubAppGraphqlFetchProvenance({
        trigger: GitHubFetchTrigger.Webhook,
      }),
    });

    if (result.status === "skipped") {
      await countDiscardResult(discardCheckRunRetry(tx, claim), summary);
      return;
    }

    await countClearResult(clearCheckRunRetry(tx, claim), summary);
  });
}

async function settleFailedProviderResult(
  claim: CheckRunRetryClaim,
  reason: StatusCheckRollupFailureReason,
  retryAfterSeconds: number | null,
  now: Date,
  summary: CheckRunRetryDrainSummary
): Promise<void> {
  const result = await withDb.tx((tx) =>
    settleRetryableCheckRunFailure(
      tx,
      claim,
      reason,
      claim.attempts,
      now,
      retryAfterSeconds
    )
  );
  if (result === "retry_scheduled") {
    summary.rescheduled++;
  } else if (result === "dead_letter") {
    summary.deadLettered++;
  } else {
    summary.missing++;
  }
}

async function countClearResult(
  resultPromise: Promise<"cleared" | "skipped_stale_branch">,
  summary: CheckRunRetryDrainSummary
): Promise<void> {
  const result = await resultPromise;
  if (result === "cleared") {
    summary.succeeded++;
  } else {
    summary.missing++;
  }
}

async function countDiscardResult(
  resultPromise: Promise<"discarded" | "missing">,
  summary: CheckRunRetryDrainSummary
): Promise<void> {
  const result = await resultPromise;
  if (result === "discarded") {
    summary.discarded++;
  } else {
    summary.missing++;
  }
}

function emptyDrainSummary(claimed: number): CheckRunRetryDrainSummary {
  return {
    claimed,
    succeeded: 0,
    rescheduled: 0,
    deadLettered: 0,
    discarded: 0,
    missing: 0,
  };
}
