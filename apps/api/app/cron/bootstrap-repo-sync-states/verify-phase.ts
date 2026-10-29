import { parseError } from "@repo/observability/error";
import { log } from "@repo/observability/log";
import {
  markOrgRepoSyncBootstrapStale,
  reconcileOrgRepoSyncStatesBestEffort,
} from "@/lib/github/github-repo-sync-state";
import {
  selectOrgIdsWithDueObservedRepositories,
  VERIFY_ORG_BATCH,
} from "@/lib/github/observed-repository-discovery";
import { verifyObservedRepositories } from "@/lib/github/observed-repository-verifier";

const LOG_PREFIX = "[bootstrap-repo-sync-states/verify]";

/**
 * The share of the tick's budget verification may spend.
 *
 * Sub-budget rather than the whole one: the bootstrap pass behind it is the lane
 * that actually materializes sync-state rows, and a verification backlog large
 * enough to fill 300 seconds would otherwise starve it every tick. The bootstrap
 * loop still measures its own deadline from the TICK's start, so the two budgets
 * cannot sum past the route's `maxDuration`.
 */
export const VERIFY_DEADLINE_MS = 90_000;

export type ObservedRepositoryVerificationSummary = {
  orgsSelected: number;
  /** Orgs whose verification pass threw. */
  orgsFailed: number;
  /** Orgs that gained ≥1 verified repository and had re-tiering attempted. */
  orgsReconciled: number;
  repositoriesAttempted: number;
  repositoriesVerified: number;
  repositoriesDenied: number;
  repositoriesDeferred: number;
  stoppedOnDeadline: boolean;
};

/**
 * PLN-1775 M3 (ISS-7403): give `verifyObservedRepositories` a production caller,
 * and give discovery its recurring half.
 *
 * Runs before the bootstrap pass so a repository verified on this tick can
 * queue targeted session-linked tier-2 reconciliation on this tick. The
 * resulting repo-sync state row is a target queue, not a repository-history PR
 * genesis signal.
 *
 * Never throws. A failure is isolated to its org so the rest of the batch — and
 * the bootstrap pass behind it — still runs.
 */
export async function runObservedRepositoryVerification(
  options: { now?: Date } = {}
): Promise<ObservedRepositoryVerificationSummary> {
  const now = options.now ?? new Date();
  const startMs = Date.now();
  const summary: ObservedRepositoryVerificationSummary = {
    orgsSelected: 0,
    orgsFailed: 0,
    orgsReconciled: 0,
    repositoriesAttempted: 0,
    repositoriesVerified: 0,
    repositoriesDenied: 0,
    repositoriesDeferred: 0,
    stoppedOnDeadline: false,
  };
  let organizationIds: string[];
  try {
    organizationIds = await selectOrgIdsWithDueObservedRepositories(
      VERIFY_ORG_BATCH,
      now
    );
  } catch (error) {
    // "Never throws" has to cover the SELECTOR, not just the per-org pass. This
    // phase is the first statement of the bootstrap route's service, so a
    // rejection here returns 500 before `selectUnbootstrappedOrgIds` is ever
    // reached and costs the tick its bootstrap lane entirely. The observation
    // table this read scans arrived with M0 and has no org equality to index
    // against; a statement timeout on it must not take down the older lane.
    log.error(`${LOG_PREFIX} due-org selection failed`, {
      error: parseError(error),
    });
    return summary;
  }
  summary.orgsSelected = organizationIds.length;

  for (const organizationId of organizationIds) {
    let result:
      | Awaited<ReturnType<typeof verifyObservedRepositories>>
      | undefined;
    try {
      result = await verifyObservedRepositories({ organizationId }, { now });
    } catch (error) {
      summary.orgsFailed += 1;
      log.error(`${LOG_PREFIX} org verification failed`, {
        organizationId,
        error: parseError(error),
      });
    }

    if (result) {
      summary.repositoriesAttempted += result.attempted;
      summary.repositoriesVerified += result.verified;
      summary.repositoriesDenied += result.denied;
      summary.repositoriesDeferred += result.deferred;
      if (result.verified > 0) {
        // A verified observed row is not yet a targeted-sync candidate:
        // `reconcileOrgRepoSyncStates` materializes the repo-sync state row the
        // targeted reconciler reads. Best-effort by construction — a missed
        // pass must not cost the verification that just succeeded.
        await unsettleAndRetierOrg(organizationId, now);
        summary.orgsReconciled += 1;
      }
    }

    if (Date.now() - startMs >= VERIFY_DEADLINE_MS) {
      summary.stoppedOnDeadline = true;
      break;
    }
  }

  return summary;
}

type BootstrapMarkerClearResult =
  | { cleared: true }
  | { cleared: false; error: unknown };

async function unsettleOrgBootstrapBestEffort(
  organizationId: string
): Promise<BootstrapMarkerClearResult> {
  try {
    await markOrgRepoSyncBootstrapStale(organizationId);
    return { cleared: true };
  } catch (error) {
    return { cleared: false, error };
  }
}

async function unsettleAndRetierOrg(
  organizationId: string,
  now: Date
): Promise<void> {
  const initialClear = await unsettleOrgBootstrapBestEffort(organizationId);
  await reconcileOrgRepoSyncStatesBestEffort(organizationId, { now });
  if (initialClear.cleared) {
    return;
  }

  // A transient clear failure must not leave this successful verification
  // stranded behind a settled marker. Re-tier first, then retry once so a
  // concurrent settlement cannot restore the marker after the compensating
  // clear. Both operations are idempotent.
  const retryClear = await unsettleOrgBootstrapBestEffort(organizationId);
  if (retryClear.cleared) {
    return;
  }
  log.error(`${LOG_PREFIX} bootstrap marker clear failed after re-tier`, {
    organizationId,
    error: parseError(retryClear.error),
  });
}
