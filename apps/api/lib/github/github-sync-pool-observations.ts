import { GitHubAccessDenialReason } from "@repo/api/src/types/github";
import { withDb } from "@repo/database";
import { GitHubProviderResultStatus } from "@repo/github";
import { classifyGitHubProviderError } from "@repo/github/provider-error-classification";
import { log } from "@repo/observability/log";
import {
  extractGitHubHttpStatus,
  GITHUB_SYNC_REPO_VERDICT_TTL_MS,
  GitHubSyncHealthState,
} from "@/lib/github/github-access";
import { saveCapabilityVerdict } from "@/lib/github/github-capability-store";
import {
  normalizeGitHubName,
  storedGitHubCredentialKind,
} from "@/lib/github/github-connection-credential";

/**
 * PLN-1525 step 2a (PLN-1535 D9): the write-back half of the sync-read pool.
 * Selection and draw live in `github-sync-client-pool.ts` and READ the pool
 * credential state; everything here records observed provider behavior back
 * into that state after a draw — rate-limit windows, backoff (including the
 * 401 backoff that replaced PLN-1525's revocation write), and lazily
 * discovered repo access.
 */

/** Observed GraphQL `rateLimit { limit cost remaining resetAt }` block. */
export type GitHubObservedRateLimit = {
  limit?: number | null;
  cost: number;
  remaining: number;
  resetAt: string | null;
};

export const GitHubSyncRepoAccessOutcome = {
  Ok: "ok",
  NoAccess: "no_access",
} as const;
export type GitHubSyncRepoAccessOutcome =
  (typeof GitHubSyncRepoAccessOutcome)[keyof typeof GitHubSyncRepoAccessOutcome];

/**
 * Provisional D9 write-back default (PLN-1525 open decision 4) — how long a
 * throttled token sits out (one tick). The selection side's counterparts
 * (reserve floor, window spend cap) live with the pool; the repo verdict TTL
 * moved to `github-access` so it sits beside the interactive TTLs it must be
 * compared against (ISS-5093).
 */
export const GITHUB_SYNC_DEFAULT_BACKOFF_MS = 15 * 60 * 1000;

const POOL_OBSERVATION_LOG_PREFIX = "[github/sync-pool-observations]";

/** The slice of a drawn pool connection the observation writers key on. */
export type PoolCredentialRef = {
  id: string;
  organizationId: string;
  scopes: string[];
};

/**
 * The layer observes what rides on transport errors: a 401 backs the row off
 * and names it; a rate-limit response puts the token into backoff for the
 * provider's ETA or one tick.
 */
export async function observePoolRequestFailure(
  connection: PoolCredentialRef,
  error: unknown
): Promise<void> {
  const status = extractGitHubHttpStatus(error);
  const observedAt = new Date();
  if (status === 401) {
    // Clerk's token is not ours to revoke, so a 401 cannot mark the registry
    // row revoked — but it must not be silent either: nothing else in
    // `classifyPoolExclusion` can see a broken Clerk credential, so without
    // this the same row is redrawn on every sweep, spending a Clerk
    // round-trip and a GitHub 401 each time with no operator signal. Backoff
    // keys on `id` alone, and the credential re-qualifies on its own once
    // Clerk serves a working token.
    await backOffPoolConnection(connection, observedAt, {
      backoffMs: GITHUB_SYNC_DEFAULT_BACKOFF_MS,
    });
    log.warn(`${POOL_OBSERVATION_LOG_PREFIX} Clerk-sourced token rejected`, {
      organizationId: connection.organizationId,
      githubUserConnectionId: connection.id,
    });
    return;
  }
  const classification = classifyGitHubProviderError(
    error,
    observedAt.getTime()
  );
  if (classification.status !== GitHubProviderResultStatus.ProviderRateLimit) {
    return;
  }
  const backoffMs =
    classification.retryAfterSeconds === null
      ? GITHUB_SYNC_DEFAULT_BACKOFF_MS
      : classification.retryAfterSeconds * 1000;
  await backOffPoolConnection(connection, observedAt, { backoffMs });
}

async function backOffPoolConnection(
  connection: PoolCredentialRef,
  observedAt: Date,
  options: { backoffMs: number }
): Promise<void> {
  await withDb((db) =>
    db.gitHubUserConnection.updateMany({
      where: {
        id: connection.id,
        organizationId: connection.organizationId,
        revokedAt: null,
      },
      data: {
        healthState: GitHubSyncHealthState.Backoff,
        backoffUntil: new Date(observedAt.getTime() + options.backoffMs),
      },
    })
  );
}

export async function recordPoolRateLimit(
  connection: PoolCredentialRef,
  observed: GitHubObservedRateLimit
): Promise<void> {
  const resetAt = observed.resetAt ? new Date(observed.resetAt) : null;
  const observedLimit = observed.limit ?? undefined;
  // A successfully observed response is proof of current health.
  const healthReset = {
    healthState: GitHubSyncHealthState.Healthy,
    backoffUntil: null,
  };
  const rowGuard = {
    id: connection.id,
    organizationId: connection.organizationId,
    revokedAt: null,
  };
  await withDb(async (db) => {
    if (!resetAt) {
      // No window anchor: count the spend conservatively; never move the
      // stored window or remaining.
      await db.gitHubUserConnection.updateMany({
        where: rowGuard,
        data: { ...healthReset, windowSpend: { increment: observed.cost } },
      });
      return;
    }
    // Responses can land out of order. Only two window relations may write:
    // a strictly NEWER window replaces everything (spend restarts at this
    // cost), and the EQUAL current window merges. An older window's late
    // response matches neither guard and is dropped — it must not rewind
    // observedResetAt or leak its cost into the current window's spend.
    const advanced = await db.gitHubUserConnection.updateMany({
      where: {
        ...rowGuard,
        OR: [{ observedResetAt: null }, { observedResetAt: { lt: resetAt } }],
      },
      data: {
        ...healthReset,
        observedLimit,
        observedRemaining: observed.remaining,
        observedResetAt: resetAt,
        windowSpend: observed.cost,
      },
    });
    if (advanced.count > 0) {
      return;
    }
    // Equal window, in-order: remaining is monotonically decreasing within
    // a window, so only a lower value may overwrite it.
    const merged = await db.gitHubUserConnection.updateMany({
      where: {
        ...rowGuard,
        observedResetAt: resetAt,
        observedRemaining: { gt: observed.remaining },
      },
      data: {
        ...healthReset,
        observedLimit,
        observedRemaining: observed.remaining,
        windowSpend: { increment: observed.cost },
      },
    });
    if (merged.count > 0) {
      return;
    }
    // Equal window, out-of-order remaining: the cost is still real spend in
    // this window; keep the newer (lower) stored remaining.
    await db.gitHubUserConnection.updateMany({
      where: { ...rowGuard, observedResetAt: resetAt },
      data: { ...healthReset, windowSpend: { increment: observed.cost } },
    });
  });
}

export async function recordPoolRepoAccess(
  connection: PoolCredentialRef,
  target: { owner: string; repo: string },
  outcome: GitHubSyncRepoAccessOutcome
): Promise<void> {
  const checkedAt = new Date();
  await withDb((db) =>
    saveCapabilityVerdict(db, {
      organizationId: connection.organizationId,
      githubUserConnectionId: connection.id,
      targetOwner: target.owner,
      normalizedTargetOwner: normalizeGitHubName(target.owner),
      targetRepo: normalizeGitHubName(target.repo),
      credentialKind: storedGitHubCredentialKind(connection.scopes),
      denialReason:
        outcome === GitHubSyncRepoAccessOutcome.NoAccess
          ? GitHubAccessDenialReason.NoInstallation
          : null,
      installationId: null,
      checkedAt,
      expiresAt: new Date(
        checkedAt.getTime() + GITHUB_SYNC_REPO_VERDICT_TTL_MS
      ),
    })
  );
}
