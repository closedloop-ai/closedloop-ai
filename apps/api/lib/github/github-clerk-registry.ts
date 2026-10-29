import { withDb } from "@repo/database";
import type { Octokit } from "@repo/github/user-token-auth";
import { parseError } from "@repo/observability/error";
import { log } from "@repo/observability/log";
import { waitUntil } from "@vercel/functions";
import {
  BranchOwnerLoginSeedError,
  seedBranchOwnersForLogin,
} from "@/app/branches/branch-owner-seed/branch-owner-seed";
import { getPrismaErrorCode } from "@/lib/db-utils";
import {
  GitHubCapabilityTtlMs,
  GitHubSyncHealthState,
} from "@/lib/github/github-access";
import type { GitHubCapabilityRecord } from "@/lib/github/github-connection-credential";
import { LAST_USED_AT_SAMPLE_INTERVAL_MS } from "@/lib/github/github-connection-credential";
import type { OrganizationWriteOutcome } from "@/lib/organization-write-receipt";
import {
  type RecordWriteInTransaction,
  writeRecorded,
} from "@/lib/record-write-in-transaction";

/**
 * PLN-1742 M1: the `GitHubUserConnection` row as a token-less REGISTRY.
 *
 * With Clerk holding the credential, the row stops being a credential store
 * and keeps only what nothing else can carry: the connection identity the
 * `GitHubAccessCapability` verdict rows hang off, the sync pool's health,
 * backoff and spend state, and the `scopes` array the three tier-2 Prisma
 * filters (`scopes: { has: "repo" }`) select on. Mirroring Clerk's scopes into
 * that array is what finally makes those filters match a real row.
 */

export type ClerkRegistryConnection = {
  connectionId: string;
  githubUserId: string;
  login: string;
  rateLimitTier: number | null;
  /** Unexpired verdict rows for the requested target; empty when unscoped. */
  capabilities: GitHubCapabilityRecord[];
};

export type SyncClerkRegistryInput = {
  organizationId: string;
  userId: string;
  /** Mirrored onto the row so tier-2's `scopes: { has: "repo" }` can match. */
  scopes: string[];
  /** Used only when the row must be created, for the one `GET /user`. */
  octokit: Octokit;
  now: Date;
  /**
   * Folds the unexpired capability read into the same registry query, exactly
   * as the stored-credential read does. Omitted by lanes with no target in
   * hand (comment writes, the webhook sync lane), which never read verdicts.
   */
  capabilityScope?: {
    normalizedTargetOwner: string;
    normalizedTargetRepo: string | null;
  };
  /**
   * ISS-12552: runs on the registry row's create or refresh transaction, so
   * the caller's record of the write commits or rolls back with it. Unlike a
   * registry hiccup, which stays best-effort, its own failure is rethrown.
   * Omitted by every lane except the Clerk link route.
   */
  recordWrite?: RecordWriteInTransaction<OrganizationWriteOutcome>;
};

/**
 * Identity for a Clerk-sourced credential, plus the registry row backing it
 * when one could be established. `connection` is null when the registry write
 * lost a race it could not recover from — the credential still works, it just
 * has no row to cache capability verdicts against.
 */
export type ClerkRegistrySyncResult = {
  githubUserId: string;
  login: string;
  connection: ClerkRegistryConnection | null;
};

const REGISTRY_LOG_PREFIX = "[github/clerk-registry]";

/**
 * Read the registry row for this user, creating it from GitHub's own identity
 * when absent, and refresh the mirrored `scopes` on the same sampled cadence
 * `lastUsedAt` already uses.
 *
 * Sampling is the point: this runs on every Clerk-sourced resolution, and an
 * unsampled write would put a Postgres write in front of every GitHub call
 * (PLN-1525 pool-protection rule 3). The cost is that a scope change can take
 * up to one sample interval to reach the tier-2 filters; the resolving lane
 * itself always uses Clerk's live scopes, so only the tier-2 gate lags.
 *
 * Returns null only when identity could not be established at all.
 */
export async function syncClerkRegistryConnection(
  input: SyncClerkRegistryInput
): Promise<ClerkRegistrySyncResult | null> {
  const existing = await readRegistryConnection(input);
  if (existing) {
    const identity = await refreshRegistryConnection(input, existing);
    return {
      githubUserId: identity.githubUserId,
      login: identity.login,
      connection: {
        connectionId: existing.id,
        githubUserId: identity.githubUserId,
        login: identity.login,
        rateLimitTier: existing.rateLimitTier,
        // A verdict earned by the PREVIOUS GitHub account says nothing about
        // the one now behind the Clerk link.
        capabilities: identity.rebound ? [] : existing.capabilities,
      },
    };
  }

  const identity = await readGitHubIdentity(input);
  if (!identity) {
    return null;
  }
  const created = await createRegistryConnection(input, identity);
  return {
    githubUserId: identity.githubUserId,
    login: identity.login,
    connection: created,
  };
}

type RegistryRow = {
  id: string;
  githubUserId: string;
  login: string;
  rateLimitTier: number | null;
  lastUsedAt: Date | null;
  revokedAt: Date | null;
  capabilities: GitHubCapabilityRecord[];
};

/** The row's identity after refresh, and whether it moved to a new account. */
type RefreshedIdentity = {
  githubUserId: string;
  login: string;
  rebound: boolean;
};

async function readRegistryConnection(
  input: SyncClerkRegistryInput
): Promise<RegistryRow | null> {
  const where = {
    organizationId_userId: {
      organizationId: input.organizationId,
      userId: input.userId,
    },
  };
  const capabilityScope = input.capabilityScope;
  if (!capabilityScope) {
    const row = await withDb((db) =>
      db.gitHubUserConnection.findUnique({
        where,
        select: REGISTRY_SELECT,
      })
    );
    return row ? { ...row, capabilities: [] } : null;
  }
  return await withDb((db) =>
    db.gitHubUserConnection.findUnique({
      where,
      select: {
        ...REGISTRY_SELECT,
        capabilities: {
          where: {
            normalizedTargetOwner: capabilityScope.normalizedTargetOwner,
            targetRepo: capabilityScope.normalizedTargetRepo,
            expiresAt: { gt: input.now },
            checkedAt: {
              gt: new Date(
                input.now.getTime() - GitHubCapabilityTtlMs.Positive
              ),
            },
          },
          select: {
            credentialKind: true,
            denialReason: true,
            installationId: true,
            checkedAt: true,
            expiresAt: true,
          },
        },
      },
    })
  );
}

const REGISTRY_SELECT = {
  id: true,
  githubUserId: true,
  login: true,
  rateLimitTier: true,
  lastUsedAt: true,
  revokedAt: true,
} as const;

/**
 * Re-anchor the row to the account Clerk is actually handing us a token for,
 * on the `lastUsedAt` sample cadence.
 *
 * The identity is NOT write-once. A user can unlink and relink a different
 * GitHub account in Clerk under the same Clerk id, and the row would otherwise
 * keep reporting the old account forever. `actingAs` and the credential's
 * `login` are built from it, so every read and every user-attributed write
 * would be attributed to an account that did not make it. When the account moves,
 * its capability verdicts move with it: they described the old account's
 * access.
 *
 * `scopes` are mirrored unconditionally. That used to be conditional on the row
 * being token-less: `storedGitHubCredentialKind` derives a STORED token's family
 * from the array (App user-to-server tokens report no scopes), so writing
 * Clerk's `repo` grant onto a row holding an App token would have relabelled
 * it `oauth_user` and handed it verdicts earned by the Clerk credential. The M5
 * tail removed the stored tokens, so there is no other family left to protect.
 */
async function refreshRegistryConnection(
  input: SyncClerkRegistryInput,
  row: RegistryRow
): Promise<RefreshedIdentity> {
  const unchanged: RefreshedIdentity = {
    githubUserId: row.githubUserId,
    login: row.login,
    rebound: false,
  };
  // A revoked row is never fresh: this resolution proves the link is back, and
  // the sampled write below is what clears the marker.
  const isFresh =
    row.revokedAt === null &&
    row.lastUsedAt !== null &&
    input.now.getTime() - row.lastUsedAt.getTime() <
      LAST_USED_AT_SAMPLE_INTERVAL_MS;
  if (isFresh) {
    return unchanged;
  }
  const observed = await readGitHubIdentity(input);
  const rebound =
    observed !== null && observed.githubUserId !== row.githubUserId;
  const identity = observed ?? unchanged;
  const recorder = registryWriteRecorder(input);
  try {
    await withDb.tx(async (tx) => {
      await tx.gitHubUserConnection.updateMany({
        where: {
          id: row.id,
          organizationId: input.organizationId,
          userId: input.userId,
        },
        data: {
          // Clerk's grant is the only scope source now, so it is mirrored
          // unconditionally. This used to skip a row that still held a stored
          // token, so that `storedGitHubCredentialKind` could not relabel an
          // App token as OAuth — there are no stored tokens left to protect.
          scopes: input.scopes,
          ...(rebound
            ? {
                githubUserId: identity.githubUserId,
                login: identity.login,
                normalizedLogin: identity.login.toLowerCase(),
              }
            : {}),
          // Only on the way back from revoked. Resetting health on every
          // sampled write would stomp the backoff the pool observer sets.
          ...(row.revokedAt === null
            ? {}
            : { revokedAt: null, healthState: GitHubSyncHealthState.Healthy }),
          lastUsedAt: input.now,
        },
      });
      if (rebound) {
        await tx.gitHubAccessCapability.deleteMany({
          where: {
            githubUserConnectionId: row.id,
            organizationId: input.organizationId,
          },
        });
      }
      await recorder.record?.(tx, { changed: true });
    });
  } catch (error) {
    recorder.rethrowIfItFailed(error);
    // Best-effort: the credential is already resolved, and a registry write
    // hiccup must not turn a usable client into a failed read.
    log.warn(`${REGISTRY_LOG_PREFIX} failed to refresh registry row`, {
      organizationId: input.organizationId,
      userId: input.userId,
    });
    return unchanged;
  }
  if (rebound) {
    scheduleBranchOwnerSeedForLogin(input, identity.login);
  }
  return {
    githubUserId: identity.githubUserId,
    login: identity.login,
    rebound,
  };
}

async function createRegistryConnection(
  input: SyncClerkRegistryInput,
  identity: { githubUserId: string; login: string }
): Promise<ClerkRegistryConnection | null> {
  const recorder = registryWriteRecorder(input);
  try {
    const created = await writeRecorded(
      recorder.record,
      () =>
        withDb((db) =>
          db.gitHubUserConnection.create({
            data: {
              organizationId: input.organizationId,
              userId: input.userId,
              githubUserId: identity.githubUserId,
              login: identity.login,
              normalizedLogin: identity.login.toLowerCase(),
              scopes: input.scopes,
              lastUsedAt: input.now,
            },
            select: { id: true, rateLimitTier: true },
          })
        ),
      () => ({ changed: true })
    );
    scheduleBranchOwnerSeedForLogin(input, identity.login);
    return {
      connectionId: created.id,
      githubUserId: identity.githubUserId,
      login: identity.login,
      rateLimitTier: created.rateLimitTier,
      capabilities: [],
    };
  } catch (error) {
    recorder.rethrowIfItFailed(error);
    if (getPrismaErrorCode(error) !== "P2002") {
      log.warn(`${REGISTRY_LOG_PREFIX} failed to create registry row`, {
        organizationId: input.organizationId,
        userId: input.userId,
      });
      return null;
    }
    // Either a concurrent resolution won the (org, user) race — re-read and
    // use the winner — or this GitHub account is already registered to a
    // DIFFERENT user in the org, which no re-read can resolve. The second case
    // leaves the credential usable without a row to cache verdicts against.
    const winner = await readRegistryConnection(input);
    if (!winner) {
      log.warn(`${REGISTRY_LOG_PREFIX} GitHub account already registered`, {
        organizationId: input.organizationId,
        userId: input.userId,
      });
      return null;
    }
    return {
      connectionId: winner.id,
      githubUserId: winner.githubUserId,
      login: winner.login,
      rateLimitTier: winner.rateLimitTier,
      capabilities: winner.capabilities,
    };
  }
}

/**
 * ISS-12463 (PLN-2192 T-1.8): a new or re-bound login can resolve the Owner
 * chain of branches no branch write will revisit. Best-effort and off the
 * response path: the credential does not depend on the seed, which walks every
 * page of the org's candidates. Outside a request context `waitUntil` is a
 * no-op and the seed still runs.
 */
function scheduleBranchOwnerSeedForLogin(
  input: SyncClerkRegistryInput,
  login: string
): void {
  waitUntil(
    seedBranchOwnersForLogin(input.organizationId, login).then(
      () => undefined,
      (error: unknown) => {
        log.warn(`${REGISTRY_LOG_PREFIX} failed to seed branch owners`, {
          status: "warn",
          organizationId: input.organizationId,
          userId: input.userId,
          error: parseError(error),
          ...(error instanceof BranchOwnerLoginSeedError
            ? {
                pagesCommitted: error.pagesCommitted,
                stampedBeforeFailure: error.stamped,
              }
            : {}),
        });
      }
    )
  );
}

/**
 * One `GET /user`, and only on first write. Every later resolution reads the
 * identity back off the registry row.
 */
async function readGitHubIdentity(
  input: SyncClerkRegistryInput
): Promise<{ githubUserId: string; login: string } | null> {
  try {
    const { data } = await input.octokit.rest.users.getAuthenticated();
    return { githubUserId: String(data.id), login: data.login };
  } catch {
    log.warn(`${REGISTRY_LOG_PREFIX} failed to read GitHub identity`, {
      organizationId: input.organizationId,
      userId: input.userId,
    });
    return null;
  }
}

/**
 * Clerk says this user has no GitHub link at all — retire the registry row.
 *
 * The marker moved here from the resolver's 401 hook (PLN-1525), which died
 * with the stored cipher it compare-and-set on. `revokedAt` is what the
 * integration status card, the insights provenance badge and the sync pool's
 * `Unhealthy` exclusion all read to say "reconnect GitHub", so without a
 * writer a user who unlinks is reported connected forever.
 *
 * Only a DEFINITIVE denial may call this. A Clerk outage resolves to
 * `unavailable` and must never carve a transient failure into a persistent
 * reconnect prompt for the whole org. Verdicts earned by the departed grant go
 * with it, in the same transaction, exactly as the 401 hook did.
 *
 * `now` is the resolution's clock, and the write is compare-and-set against it:
 * a row USED since this resolution began belongs to a link that came back while
 * this denial was in flight (unlink → relink → a later resolution refreshes the
 * row), and retiring it would drop a working user out of the sync pool until
 * something interactive healed the row. That is the guard the old 401 hook got
 * for free from its CAS on the stored cipher.
 */
export async function markClerkRegistryUnlinked(input: {
  organizationId: string;
  userId: string;
  now: Date;
  /**
   * ISS-12552: runs on the marker's transaction; a no-op when there is no
   * row or the marker is already set. Only the Clerk link route passes it.
   */
  recordWrite?: RecordWriteInTransaction<OrganizationWriteOutcome>;
}): Promise<void> {
  const recorder = registryWriteRecorder(input);
  try {
    await withDb.tx(async (tx) => {
      const row = await tx.gitHubUserConnection.findUnique({
        where: {
          organizationId_userId: {
            organizationId: input.organizationId,
            userId: input.userId,
          },
        },
        select: { id: true },
      });
      if (!row) {
        await recorder.record?.(tx, { changed: false });
        return;
      }
      const revoked = await tx.gitHubUserConnection.updateMany({
        where: {
          id: row.id,
          organizationId: input.organizationId,
          revokedAt: null,
          // A row never drawn or never refreshed carries no evidence either
          // way, so it stays eligible.
          OR: [{ lastUsedAt: null }, { lastUsedAt: { lt: input.now } }],
        },
        data: {
          revokedAt: input.now,
          healthState: GitHubSyncHealthState.Unhealthy,
        },
      });
      if (revoked.count === 0) {
        await recorder.record?.(tx, { changed: false });
        return;
      }
      await tx.gitHubAccessCapability.deleteMany({
        where: {
          githubUserConnectionId: row.id,
          organizationId: input.organizationId,
        },
      });
      await recorder.record?.(tx, { changed: true });
    });
  } catch (error) {
    recorder.rethrowIfItFailed(error);
    // Best-effort bookkeeping on a path that is already denying the caller.
    log.warn(`${REGISTRY_LOG_PREFIX} failed to mark registry row unlinked`, {
      organizationId: input.organizationId,
      userId: input.userId,
    });
  }
}

/**
 * ISS-12552: runs the caller's `recordWrite` on a registry transaction and
 * remembers whether it was the part that failed, so the best-effort catch
 * around the registry write can rethrow that failure and swallow only its
 * own. `record` is undefined when the caller records nothing, so the registry
 * write keeps its pre-receipt shape.
 */
function registryWriteRecorder(input: {
  recordWrite?: RecordWriteInTransaction<OrganizationWriteOutcome>;
}): {
  record: RecordWriteInTransaction<OrganizationWriteOutcome> | undefined;
  rethrowIfItFailed: (error: unknown) => void;
} {
  let failed = false;
  const { recordWrite } = input;
  return {
    record:
      recordWrite &&
      (async (tx, written) => {
        try {
          await recordWrite(tx, written);
        } catch (error) {
          failed = true;
          throw error;
        }
      }),
    rethrowIfItFailed(error) {
      if (failed) {
        throw error;
      }
    },
  };
}
