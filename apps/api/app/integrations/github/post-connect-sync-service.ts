import { parseError } from "@repo/observability/error";
import { log } from "@repo/observability/log";
import type { GitHubOrgReconcileSummary } from "@/app/cron/reconcile-pull-requests/service";
import { githubPullRequestReconcilerService } from "@/app/cron/reconcile-pull-requests/service";
import {
  markOrgRepoSyncBootstrapStale,
  reconcileOrgRepoSyncStatesBestEffort,
} from "@/lib/github/github-repo-sync-state";
import {
  clearPendingVerificationBackoff,
  verifyObservedRepositories,
} from "@/lib/github/observed-repository-verifier";
import {
  claimOrganizationRun,
  type OrganizationRunClaim,
  type OrganizationRunGateDefinition,
  releaseOrganizationRun,
} from "@/lib/organization-run-gate";

const LOG_PREFIX = "[github/post-connect-sync]";

/**
 * Repos this pass sweeps. Small on purpose: it runs in a route's `waitUntil`
 * lane behind a user who just connected, and `reconcileRepo` is itself bounded
 * per repo. Whatever the bound leaves is still due, and the cron takes it.
 */
export const POST_CONNECT_REPO_LIMIT = 5;

const POST_CONNECT_SYNC_GATE_SETTINGS_KEY = "githubPostConnectSyncGate";

/**
 * Matches the wiring route's `maxDuration`: the platform kills the lane at that
 * ceiling, so a longer lease would hold the gate past the point where the run it
 * describes can still be alive.
 *
 * Route-segment config must be a static literal, so `clerk-link/route.ts` writes
 * its own number and `post-connect-max-duration.test.ts` pins the two together.
 * Exported for that test alone.
 */
export const POST_CONNECT_SYNC_LEASE_MS = 5 * 60 * 1000;
/**
 * The linking page can POST again on a reload or a second tab, and each call
 * would otherwise re-verify, re-reconcile, and re-sweep on the same pool budget.
 * Short enough that a user who reconnects after a failed link still gets a fresh
 * pass rather than a silent no-op.
 */
const POST_CONNECT_SYNC_COOLDOWN_MS = 60 * 1000;

const POST_CONNECT_SYNC_GATE: OrganizationRunGateDefinition = {
  settingsKey: POST_CONNECT_SYNC_GATE_SETTINGS_KEY,
  lockName: "github-post-connect-sync",
  leaseMs: POST_CONNECT_SYNC_LEASE_MS,
  cooldownMs: POST_CONNECT_SYNC_COOLDOWN_MS,
  writeSubject: "GitHub post-connect sync settings write",
};

export type PostConnectObservedSyncSummary = GitHubOrgReconcileSummary & {
  /**
   * False when another run holds the lane or is inside its cooldown — never
   * because the run itself failed. A run that took the lane and then threw
   * reports `claimed: true` with `failed: true`.
   */
  claimed: boolean;
  /**
   * The chain threw after taking the lane. The counts are then what an empty run
   * would report, NOT a measurement: earlier steps may already have persisted
   * verified rows or sync-state rows before the throw.
   */
  failed: boolean;
  repositoriesAttempted: number;
  repositoriesVerified: number;
  repositoriesDenied: number;
  repositoriesDeferred: number;
};

/**
 * ISS-7721: run the observed-repository sync chain for an organization that just
 * connected GitHub, instead of waiting for the crons that would otherwise get to
 * it.
 *
 * A connect changes the credential ladder for every repo the org already has in
 * the repo-sync state table. This path verifies pending observed rows, queues
 * newly verified repositories for targeted reconciliation, refreshes the ladder
 * for existing candidates, then sweeps this org's due repos without waiting for
 * the hourly cron.
 *
 * The App lane already has this: claiming an installation fires
 * `reconcileOrgRepoSyncStatesBestEffort` from `service/installation-claim.ts`.
 * This is the missing analogue for the lane that has no installation to claim.
 *
 * Never throws — it runs in a `waitUntil` lane where a rejection is nobody's to
 * catch, and no failure here may cost the caller its response.
 */
export async function runPostConnectObservedSync(input: {
  organizationId: string;
  now?: Date;
}): Promise<PostConnectObservedSyncSummary> {
  const now = input.now ?? new Date();
  const claim = await claimGateOrNull(input.organizationId, now);
  if (!claim?.claimed) {
    // The lane was never taken, by refusal or by a failed claim, so the zeroed
    // counts are the truth rather than a run whose progress went unrecorded.
    return emptyPostConnectSummary();
  }
  try {
    const summary = await runPostConnectObservedSyncAfterClaim(
      input.organizationId,
      now
    );
    log.info(`${LOG_PREFIX} post-connect sync completed`, {
      organizationId: input.organizationId,
      ...summary,
    });
    return summary;
  } catch (error) {
    logSyncFailure(input.organizationId, error);
    return { ...emptyPostConnectSummary(), claimed: true, failed: true };
  } finally {
    await releaseBestEffort(input.organizationId);
  }
}

async function claimGateOrNull(
  organizationId: string,
  now: Date
): Promise<OrganizationRunClaim | null> {
  try {
    return await claimOrganizationRun(organizationId, POST_CONNECT_SYNC_GATE, {
      now,
    });
  } catch (error) {
    logSyncFailure(organizationId, error);
    return null;
  }
}

function logSyncFailure(organizationId: string, error: unknown): void {
  log.error(`${LOG_PREFIX} post-connect sync failed`, {
    organizationId,
    error: parseError(error),
  });
}

async function runPostConnectObservedSyncAfterClaim(
  organizationId: string,
  now: Date
): Promise<PostConnectObservedSyncSummary> {
  // Before verifying, not after: a cron pass that could not draw a credential
  // parks every pending row behind a 6h horizon, and this org just replaced the
  // credential that failed. Skipping this makes a reconnect verify nothing and
  // sweep nothing until that horizon expires.
  await clearVerificationBackoffBestEffort(organizationId);
  const verification = await verifyObservedRepositories(
    { organizationId },
    { now }
  );
  if (verification.verified > 0) {
    // Un-settle before reconciling so a failed best-effort pass leaves the newly
    // verified repository selectable by the bootstrap lane.
    await markOrgRepoSyncBootstrapStale(organizationId);
  }
  // Unconditional: a connect IS the org-wide signal this function documents as
  // its trigger — the credential ladder just changed for every repo the org has
  // — so it runs even when this pass verified nothing new.
  // No field records whether this settled: the helper swallows its own failures
  // by design, so a caller-side flag could only ever report `true` — a claim the
  // summary is not entitled to make. The helper's own log.warn is the record.
  await reconcileOrgRepoSyncStatesBestEffort(organizationId, { now });
  const sweep = await githubPullRequestReconcilerService.runForOrganization(
    organizationId,
    { limit: POST_CONNECT_REPO_LIMIT, now }
  );
  return {
    ...sweep,
    claimed: true,
    failed: false,
    repositoriesAttempted: verification.attempted,
    repositoriesVerified: verification.verified,
    repositoriesDenied: verification.denied,
    repositoriesDeferred: verification.deferred,
  };
}

/**
 * Best-effort for the same reason the count in `runForOrganization` is: this
 * widens what the pass can see, so losing it costs the reconnect some of its
 * rows, while letting it throw would cost the org the entire pass.
 */
async function clearVerificationBackoffBestEffort(
  organizationId: string
): Promise<void> {
  try {
    await clearPendingVerificationBackoff(organizationId);
  } catch (error) {
    log.warn(`${LOG_PREFIX} failed to clear the verification backoff`, {
      organizationId,
      error: parseError(error),
    });
  }
}

/**
 * The release runs in a `finally` on a path that may already be failing; letting
 * it throw would replace the real error with a bookkeeping one. The lease bounds
 * the damage of a missed release on its own.
 */
async function releaseBestEffort(organizationId: string): Promise<void> {
  try {
    await releaseOrganizationRun(organizationId, POST_CONNECT_SYNC_GATE);
  } catch (error) {
    log.warn(`${LOG_PREFIX} failed to release the post-connect sync gate`, {
      organizationId,
      error: parseError(error),
    });
  }
}

function emptyPostConnectSummary(): PostConnectObservedSyncSummary {
  return {
    claimed: false,
    failed: false,
    repositoriesAttempted: 0,
    repositoriesVerified: 0,
    repositoriesDenied: 0,
    repositoriesDeferred: 0,
    reposSelected: 0,
    reposSwept: 0,
    reposDeferredBudget: 0,
    reposDeferredContention: 0,
    reposReclassified: 0,
    reposFailed: 0,
    // Null, not 0: no sweep ran, so the eligible population was never counted,
    // and 0 would report full coverage of a number nobody took.
    reposRemaining: null,
    pullRequestsWritten: 0,
  };
}
