import type { GitHubBundledPullRequestsObservation } from "@repo/api/src/types/github-read-model";
import { GitHubProviderResultStatus } from "@repo/github";
import { parseError } from "@repo/observability/error";
import { log } from "@repo/observability/log";
import type { GitHubSyncClient } from "@/lib/github/github-sync-client-pool";
import { GitHubSyncRepoAccessOutcome } from "@/lib/github/github-sync-pool-observations";

/**
 * What a server-initiated sweep owes the credential it drew from the sync pool.
 *
 * Two writes the pool cannot make for itself: GraphQL budget data rides the
 * response body, and repository reach is only observable from the read's
 * outcome. Every consumer of `getGitHubSyncClient` that pages GraphQL owes both
 * — the reconciler cron and the ISS-7721 backfill sweep — so they live here
 * rather than as a private copy in each caller. Both are no-ops on the
 * installation lane, where reach is governed by the installation's repository
 * list rather than by per-credential verdicts.
 */

type SyncClientFeedbackContext = {
  /** Names the calling lane in this module's warnings. */
  logPrefix: string;
  organizationId: string;
  repositoryFullName: string;
};

/**
 * Feed EVERY page's observed cost back into the drawn token's pool state so
 * `windowSpend` accounts for a multi-page sweep, not just the last page.
 *
 * Best-effort, like the two verdict writers below: `recordRateLimit` writes
 * through the pool store, and letting that write propagate would turn a
 * SUCCESSFUL provider read into the caller's generic repository failure and
 * skip the projection it already fetched. Losing a window sample costs one
 * over-generous draw next tick; losing the projection costs the user a stale
 * page until the next sweep.
 */
export async function recordSyncClientRateLimits(
  client: GitHubSyncClient,
  observations: readonly GitHubBundledPullRequestsObservation[],
  context: SyncClientFeedbackContext
): Promise<void> {
  try {
    for (const observation of observations) {
      const { cost, remaining, resetAt } = observation.rateLimit;
      if (typeof cost === "number" && typeof remaining === "number") {
        await client.recordRateLimit({ cost, remaining, resetAt });
      }
    }
  } catch (error) {
    log.warn(`${context.logPrefix} failed to record the observed rate limit`, {
      organizationId: context.organizationId,
      repositoryFullName: context.repositoryFullName,
      error: parseError(error),
    });
  }
}

/**
 * Record that the drawn credential DID reach the repo, so the pool ranks a
 * known-good token first next time (lazy discovery — never a proactive crawl).
 *
 * Best-effort for the same reason as the no-access verdict below: losing a
 * positive verdict costs one unranked draw next tick, while letting the
 * bookkeeping write abort the caller would lose the projection it just fetched.
 */
export async function recordSyncClientRepoReached(
  client: GitHubSyncClient,
  context: SyncClientFeedbackContext
): Promise<void> {
  try {
    await client.recordRepoAccess(GitHubSyncRepoAccessOutcome.Ok);
  } catch (error) {
    log.warn(`${context.logPrefix} failed to record repo access`, {
      organizationId: context.organizationId,
      repositoryFullName: context.repositoryFullName,
      error: parseError(error),
    });
  }
}

/**
 * Record a no-access verdict when the read failed because this credential
 * cannot reach the repo (ISS-5093), so the pool stops re-drawing it and the
 * tier can eventually demote the repo instead of sweeping it forever.
 *
 * Best-effort by design. `recordRepoAccess` writes through the capability
 * store, which rethrows anything that is not a unique-constraint race, and the
 * caller must still settle its own failure state — losing a verdict costs one
 * extra draw next tick, while losing the failure settlement would lose the
 * backoff counter entirely. Same reason the pool's own octokit hook swallows
 * its bookkeeping errors.
 */
export async function recordSyncClientNoAccessIfRepoDenied(
  client: GitHubSyncClient,
  status: GitHubProviderResultStatus,
  context: SyncClientFeedbackContext
): Promise<void> {
  // ONLY the two repo-scoped statuses. `ProviderPermissionFiltered` is
  // deliberately absent: the generic HTTP-403 fall-through produces it too, so
  // treating it as a repo denial would mint a 6h verdict against a healthy
  // credential on an org-level 403 (SAML, IP allowlist, OAuth App restriction)
  // or on a 403 from page 2 of a read whose page 1 already reached the repo.
  const denied =
    status === GitHubProviderResultStatus.ProviderRepoForbidden ||
    status === GitHubProviderResultStatus.ProviderRepoNotFound;
  if (!denied) {
    return;
  }
  try {
    await client.recordRepoAccess(GitHubSyncRepoAccessOutcome.NoAccess);
  } catch (error) {
    log.warn(`${context.logPrefix} failed to record repo no-access`, {
      organizationId: context.organizationId,
      repositoryFullName: context.repositoryFullName,
      error: parseError(error),
    });
  }
}
