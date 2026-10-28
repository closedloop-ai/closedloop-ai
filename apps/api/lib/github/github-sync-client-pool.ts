import {
  GitHubAccessDenialReason,
  GitHubCredentialKind,
} from "@repo/api/src/types/github";
import {
  type Result as DomainResult,
  Result,
} from "@repo/api/src/types/result";
import { withDb } from "@repo/database";
import { GitHubProviderResultStatus } from "@repo/github";
import { getUserTokenOctokit } from "@repo/github/user-token-auth";
import { log } from "@repo/observability/log";
import {
  type GitHubAccessError,
  type GitHubClient,
  GitHubSyncHealthState,
  mapInstallationAcquisitionFailure,
} from "@/lib/github/github-access";
import {
  activeRepoVerdictWhere,
  type GitHubRepoVerdictRow,
  hasActiveNoAccessVerdict,
} from "@/lib/github/github-capability-store";
import {
  meetsGitHubRepoScopeFloor,
  storedGitHubCredentialKind,
} from "@/lib/github/github-connection-credential";
import {
  type GitHubObservedRateLimit,
  type GitHubSyncRepoAccessOutcome,
  observePoolRequestFailure,
  recordPoolRateLimit,
  recordPoolRepoAccess,
} from "@/lib/github/github-sync-pool-observations";
import { acquireGitHubUserToken } from "@/lib/github/github-user-credential";
import { acquireInstallationClient } from "@/lib/github/installation-client";
import { findCoveringInstallation } from "@/lib/github/installation-repository-lookup";

/**
 * PLN-1525 step 2a (PLN-1535 D9): the `sync-read` lane. An org-scoped read
 * with NO requesting user — the credential is the org's installation when it
 * covers the target repo (tier 1), else drawn from the POOL of the org's
 * connected users under the budget policy (tier 2). A user's rate-limit
 * bucket is shared with all their other tooling (gh CLI, IDE extensions), so
 * the pool never concentrates on one token while others qualify and never
 * draws a token below its reserve floor.
 */

export type GetGitHubSyncClientInput = {
  organizationId: string;
  target: { owner: string; repo: string };
};

export type GetGitHubSyncClientOptions = {
  /** Pin the clock in tests. */
  now?: Date;
  /** Test seam: transport override for pool-drawn octokits. */
  fetch?: typeof fetch;
};

export type GitHubSyncClient = GitHubClient & {
  /**
   * Internal user UUID of the token owner for a user (tier-2) draw, or null for
   * the installation lane. Callers persist this as the fetch provenance's
   * credential owner so a tier-2 projection records WHICH user's token fetched
   * it. Distinct from `actingAs.githubUserId`, which is GitHub's numeric id.
   */
  credentialOwnerId: string | null;
  /**
   * Feed every observed GraphQL `rateLimit` block back into the drawn
   * token's pool state (REST 401/429 are observed automatically through the
   * client; GraphQL budget data rides the response body, which only the
   * caller sees). No-op on the installation lane — pool state is a property
   * of user tokens.
   */
  recordRateLimit(observed: GitHubObservedRateLimit): Promise<void>;
  /**
   * Lazy access discovery (never proactive crawls): record whether the drawn
   * token reached the target repo. No-op on the installation lane.
   */
  recordRepoAccess(outcome: GitHubSyncRepoAccessOutcome): Promise<void>;
};

/**
 * Provisional D9 selection defaults (PLN-1525 open decision 4) — PLN-1535
 * M0's cost logging tunes these before the reconciler hardens. The write-back
 * counterparts (repo verdict TTL, backoff) live with the observation writers
 * in `github-sync-pool-observations.ts`.
 * - reserve floor: never draw a token whose last-observed remaining is below
 *   this fraction of its observed limit (the floor yields automatically to
 *   the user's own workload, since `remaining` is their global bucket);
 * - window spend cap: our own spend budget per token per rate window.
 */
export const GITHUB_SYNC_RESERVE_FLOOR_RATIO = 0.5;
export const GITHUB_SYNC_WINDOW_SPEND_CAP = 1000;

/** GitHub's default user GraphQL point budget, assumed until observed. */
const DEFAULT_GRAPHQL_POINT_LIMIT = 5000;

const POOL_LOG_PREFIX = "[github/sync-client-pool]";

export async function getGitHubSyncClient(
  input: GetGitHubSyncClientInput,
  options: GetGitHubSyncClientOptions = {}
): Promise<DomainResult<GitHubSyncClient, GitHubAccessError>> {
  const now = options.now ?? new Date();
  const installationResult = await resolveCoveringInstallation(input);
  if (installationResult) {
    return installationResult;
  }
  return await drawFromPool(input, options, now);
}

/**
 * Tier 1: the org's active installation, when the target repo is on it (and
 * not tombstoned). Installation buckets are per-install and org-owned, so
 * none of the pool budget policy applies. Returns null only when no covering
 * installation exists (continue to the pool); a covering installation whose
 * token acquisition fails yields a definitive transient denial instead —
 * demoting an app outage to the pool would silently spend user budget on
 * repos the installation owns.
 */
async function resolveCoveringInstallation(
  input: GetGitHubSyncClientInput
): Promise<DomainResult<GitHubSyncClient, GitHubAccessError> | null> {
  const covering = await findCoveringInstallation(
    input.organizationId,
    `${input.target.owner}/${input.target.repo}`
  );
  if (!covering) {
    return null;
  }
  const acquired = await acquireInstallationClient(covering.installationId);
  if (acquired.status !== GitHubProviderResultStatus.Success) {
    return Result.err(mapInstallationAcquisitionFailure(acquired));
  }
  return Result.ok({
    octokit: acquired.value,
    kind: GitHubCredentialKind.Installation,
    actingAs: { installationId: covering.installationId },
    // No user owns an installation token.
    credentialOwnerId: null,
    rateLimitTier: null,
    recordRateLimit: () => Promise.resolve(),
    recordRepoAccess: () => Promise.resolve(),
  });
}

type PoolConnectionRow = {
  id: string;
  organizationId: string;
  userId: string;
  githubUserId: string;
  login: string;
  scopes: string[];
  rateLimitTier: number | null;
  observedLimit: number | null;
  observedRemaining: number | null;
  observedResetAt: Date | null;
  windowSpend: number;
  backoffUntil: Date | null;
  healthState: string;
  lastUsedAt: Date | null;
  revokedAt: Date | null;
  capabilities: GitHubRepoVerdictRow[];
};

/** Why a connection cannot be drawn right now. */
const PoolExclusion = {
  Budget: "budget",
  InsufficientScope: "insufficient_scope",
  NoAccess: "no_access",
  Unhealthy: "unhealthy",
} as const;
type PoolExclusion = (typeof PoolExclusion)[keyof typeof PoolExclusion];

async function drawFromPool(
  input: GetGitHubSyncClientInput,
  options: GetGitHubSyncClientOptions,
  now: Date
): Promise<DomainResult<GitHubSyncClient, GitHubAccessError>> {
  const connections = await readPoolConnections(input, now);
  if (connections.length === 0) {
    return Result.err({ reason: GitHubAccessDenialReason.NotConnected });
  }

  const exclusions: PoolExclusion[] = [];
  const candidates: PoolConnectionRow[] = [];
  for (const connection of connections) {
    const exclusion = classifyPoolExclusion(connection, now);
    if (exclusion) {
      exclusions.push(exclusion);
    } else {
      candidates.push(connection);
    }
  }
  if (candidates.length === 0) {
    return Result.err({ reason: mapPoolExhaustion(exclusions) });
  }

  sortPoolCandidates(candidates, now);
  const passedOver: GitHubAccessDenialReason[] = [];
  let contended = false;
  for (const candidate of candidates) {
    const attempt = await buildPoolClient(candidate, input, options, now);
    if (attempt.ok) {
      return Result.ok(attempt.client);
    }
    if (attempt.denial) {
      passedOver.push(attempt.denial);
    } else {
      contended = true;
    }
  }
  // No candidate produced a client: either Clerk could not serve their owners,
  // or a concurrent draw won the claim on every one of them.
  return Result.err({ reason: mapPassedOverDenials(passedOver, contended) });
}

/**
 * What an all-candidates-passed-over draw denies with.
 *
 * A transient reason outranks a durable one: the reconcile cron backs off on
 * `unavailable` but RE-TIERS the repo on `not_connected`, so one org member's
 * missing link must not turn a Clerk blip into a demotion sweep.
 *
 * `contention` outranks both (ISS-8270). A lost CAS means a concurrent draw
 * WON that connection, so the org's credential is usable this instant — the
 * one thing `not_connected` claims it is not. With N sweeps racing a
 * single-connection pool, N−1 lose by construction, and answering
 * `not_connected` reclassified those repos on every tick.
 */
function mapPassedOverDenials(
  denials: GitHubAccessDenialReason[],
  contended: boolean
): GitHubAccessDenialReason {
  if (contended) {
    return GitHubAccessDenialReason.Contention;
  }
  if (denials.includes(GitHubAccessDenialReason.Unavailable)) {
    return GitHubAccessDenialReason.Unavailable;
  }
  return GitHubAccessDenialReason.NotConnected;
}

async function readPoolConnections(
  input: GetGitHubSyncClientInput,
  now: Date
): Promise<PoolConnectionRow[]> {
  // Revoked rows are read (not filtered) so a fully-revoked pool surfaces
  // as `revoked` — a reconnect prompt — rather than `not_connected`. The
  // marker is written by `markClerkRegistryUnlinked` when Clerk reports the
  // owner's GitHub link is gone.
  return await withDb((db) =>
    db.gitHubUserConnection.findMany({
      where: { organizationId: input.organizationId },
      select: {
        id: true,
        organizationId: true,
        userId: true,
        githubUserId: true,
        login: true,
        scopes: true,
        rateLimitTier: true,
        observedLimit: true,
        observedRemaining: true,
        observedResetAt: true,
        windowSpend: true,
        backoffUntil: true,
        healthState: true,
        lastUsedAt: true,
        revokedAt: true,
        capabilities: {
          where: activeRepoVerdictWhere(input.target, now),
          select: {
            credentialKind: true,
            denialReason: true,
            checkedAt: true,
            expiresAt: true,
          },
        },
      },
    })
  );
}

function classifyPoolExclusion(
  connection: PoolConnectionRow,
  now: Date
): PoolExclusion | null {
  if (connection.revokedAt !== null) {
    return PoolExclusion.Unhealthy;
  }
  if (connection.healthState === GitHubSyncHealthState.Unhealthy) {
    return PoolExclusion.Unhealthy;
  }
  // OAuth-family tokens (classic scopes) need `repo`; App-family tokens
  // (empty scopes) are governed by installation reach instead. Distinct from
  // Unhealthy — the remedy is a scope-widening reconnect, and the interactive
  // resolver reports the same condition as insufficient_scope.
  if (!meetsGitHubRepoScopeFloor(connection.scopes)) {
    return PoolExclusion.InsufficientScope;
  }
  // Any active verdict is enough to skip a draw — unlike the repo-sync tier,
  // which demands a sync-durable one because demotion is far more expensive
  // than passing over one credential for one tick.
  if (hasActiveNoAccessVerdict(connection.capabilities, connection.scopes)) {
    return PoolExclusion.NoAccess;
  }
  if (
    connection.backoffUntil &&
    connection.backoffUntil.getTime() > now.getTime()
  ) {
    return PoolExclusion.Budget;
  }
  // A reset window restores the bucket and our spend budget — stale
  // observations from the previous window must not floor the token.
  const windowPassed =
    connection.observedResetAt !== null &&
    connection.observedResetAt.getTime() <= now.getTime();
  if (windowPassed) {
    return null;
  }
  if (connection.windowSpend >= GITHUB_SYNC_WINDOW_SPEND_CAP) {
    return PoolExclusion.Budget;
  }
  if (connection.observedRemaining !== null) {
    const limit = connection.observedLimit ?? DEFAULT_GRAPHQL_POINT_LIMIT;
    if (
      connection.observedRemaining <
      limit * GITHUB_SYNC_RESERVE_FLOOR_RATIO
    ) {
      return PoolExclusion.Budget;
    }
  }
  return null;
}

function mapPoolExhaustion(
  exclusions: PoolExclusion[]
): GitHubAccessDenialReason {
  // Floored/backed-off tokens recover on their own — defer the sweep
  // (cursor preserved, coverage-visible; PLN-1535), never "one more page".
  if (exclusions.includes(PoolExclusion.Budget)) {
    return GitHubAccessDenialReason.BudgetDeferred;
  }
  // Unhealthy tokens need a user to reconnect; that remedy outranks
  // no-access rows, which no reconnect can fix for this repo.
  if (exclusions.includes(PoolExclusion.Unhealthy)) {
    return GitHubAccessDenialReason.Revoked;
  }
  if (exclusions.includes(PoolExclusion.InsufficientScope)) {
    return GitHubAccessDenialReason.InsufficientScope;
  }
  return GitHubAccessDenialReason.NoInstallation;
}

/**
 * Selection order (PLN-1535 D9): known-access first, then highest observed
 * remaining (unobserved tokens rank as full buckets), then
 * least-recently-used-by-us — which is what rotates the pool.
 */
function sortPoolCandidates(candidates: PoolConnectionRow[], now: Date): void {
  candidates.sort((a, b) => {
    const knownAccess = poolKnownAccessRank(a) - poolKnownAccessRank(b);
    if (knownAccess !== 0) {
      return knownAccess;
    }
    const remaining =
      poolEffectiveRemaining(b, now) - poolEffectiveRemaining(a, now);
    if (remaining !== 0) {
      return remaining;
    }
    return poolLastUsedRank(a) - poolLastUsedRank(b);
  });
}

function poolKnownAccessRank(connection: PoolConnectionRow): number {
  const knownAccess = matchingCapabilities(connection).some(
    (row) => row.denialReason === null
  );
  return knownAccess ? 0 : 1;
}

/**
 * Verdict rows earned by the OTHER credential family say nothing about this
 * one: a reconnect can flip the scopes-derived family without changing the
 * connection id, and e.g. an OAuth-restriction denial does not bind an App
 * user token. Mismatched rows are ignored for both exclusion and ranking —
 * the same rule as the interactive resolver's readCachedVerdict.
 */
function matchingCapabilities(
  connection: PoolConnectionRow
): PoolConnectionRow["capabilities"] {
  const kind = storedGitHubCredentialKind(connection.scopes);
  return connection.capabilities.filter((row) => row.credentialKind === kind);
}

function poolEffectiveRemaining(
  connection: PoolConnectionRow,
  now: Date
): number {
  const limit = connection.observedLimit ?? DEFAULT_GRAPHQL_POINT_LIMIT;
  const windowPassed =
    connection.observedResetAt !== null &&
    connection.observedResetAt.getTime() <= now.getTime();
  if (connection.observedRemaining === null || windowPassed) {
    return limit;
  }
  return connection.observedRemaining;
}

function poolLastUsedRank(connection: PoolConnectionRow): number {
  return connection.lastUsedAt ? connection.lastUsedAt.getTime() : 0;
}

/**
 * A draw attempt against one candidate. `denial` is null when the candidate
 * was lost to the CAS race rather than to a credential failure — a race says
 * nothing about the org's connection state, so it colours the exhaustion
 * reason as `contention` rather than as any statement about the credential.
 */
type PoolDrawAttempt =
  | { ok: true; client: GitHubSyncClient }
  | { ok: false; denial: GitHubAccessDenialReason | null };

async function buildPoolClient(
  connection: PoolConnectionRow,
  input: GetGitHubSyncClientInput,
  options: GetGitHubSyncClientOptions,
  now: Date
): Promise<PoolDrawAttempt> {
  const acquired = await acquireGitHubUserToken({
    organizationId: connection.organizationId,
    userId: connection.userId,
    now,
  });
  if (!acquired.ok) {
    return { ok: false, denial: acquired.denial };
  }
  const token = acquired.token;

  // Draw claim, CAS'd on the LRU snapshot this selection ranked with:
  // concurrent sweeps that chose the same token race on this write, the
  // loser moves to its next candidate, and traffic never concentrates on
  // one user. (Budget reservation for in-flight cost is deliberately not
  // attempted in v1 — the spend cap is provisional until PLN-1535 M0 data.)
  const claimed = await withDb((db) =>
    db.gitHubUserConnection.updateMany({
      where: {
        id: connection.id,
        organizationId: connection.organizationId,
        lastUsedAt: connection.lastUsedAt,
      },
      data: { lastUsedAt: now },
    })
  );
  if (claimed.count === 0) {
    return { ok: false, denial: null };
  }

  const octokit = getUserTokenOctokit(token, { fetch: options.fetch });
  octokit.hook.error("request", async (error) => {
    try {
      await observePoolRequestFailure(connection, error);
    } catch {
      // Never mask the provider failure with a bookkeeping failure.
      log.warn(`${POOL_LOG_PREFIX} failed to record request failure`, {
        organizationId: connection.organizationId,
      });
    }
    throw error;
  });

  return {
    ok: true,
    client: {
      octokit,
      kind: storedGitHubCredentialKind(connection.scopes),
      actingAs: {
        githubUserId: connection.githubUserId,
        login: connection.login,
      },
      // The internal user whose token this is — persisted as fetch provenance
      // so a tier-2 projection records which user's credential fetched it
      // (tamsinb).
      credentialOwnerId: connection.userId,
      rateLimitTier: connection.rateLimitTier,
      recordRateLimit: (rateLimit) =>
        recordPoolRateLimit(connection, rateLimit),
      recordRepoAccess: (outcome) =>
        recordPoolRepoAccess(connection, input.target, outcome),
    },
  };
}
