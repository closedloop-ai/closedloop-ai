import type {
  GitHubAccessDenialReason,
  GitHubCredentialKind,
} from "@repo/api/src/types/github";
import { type TransactionClient, withDb } from "@repo/database";
import { getPrismaErrorCode } from "@/lib/db-utils";
import {
  GITHUB_SYNC_REPO_VERDICT_TTL_MS,
  GitHubSyncHealthState,
} from "@/lib/github/github-access";
import {
  normalizeGitHubName,
  storedGitHubCredentialKind,
} from "@/lib/github/github-connection-credential";

/**
 * PLN-1525: writes to the `GitHubAccessCapability` verdict cache and the
 * 401-revocation invalidation path. Reads are folded into the connection
 * query (`github-connection-credential.ts`) so they cost zero extra queries.
 */

export type GitHubCapabilityClient = {
  gitHubAccessCapability: Pick<
    TransactionClient["gitHubAccessCapability"],
    "updateMany" | "create" | "deleteMany"
  >;
};

export type GitHubCapabilityVerdict = {
  organizationId: string;
  githubUserConnectionId: string;
  targetOwner: string;
  normalizedTargetOwner: string;
  /**
   * Verdict granularity matches probe granularity: non-null (normalized via
   * normalizeGitHubName) for repo-bearing targets in both lanes; null only
   * for owner-only interactive targets.
   */
  targetRepo: string | null;
  credentialKind: GitHubCredentialKind;
  /** null = positive verdict (the credential reaches the target). */
  denialReason: GitHubAccessDenialReason | null;
  installationId: string | null;
  checkedAt: Date;
  expiresAt: Date;
};

/**
 * Race-safe, freshness-safe write of one verdict row. Row identity is
 * enforced by partial unique indexes (see the model's NOTE in schema.prisma),
 * which Prisma `upsert` cannot target — so this is update-first, then create
 * with a P2002 catch that falls back to updating the concurrent winner's row.
 *
 * Both update paths are gated on `checkedAt <= incoming.checkedAt`:
 * process-local single-flight does not protect separate serverless
 * instances, and a slower, older probe must never move the cache backward
 * over a newer verdict. A dropped stale write is the correct outcome.
 * `organizationId` rides in every predicate per the org-scoping rule.
 */
export async function saveCapabilityVerdict(
  db: GitHubCapabilityClient,
  verdict: GitHubCapabilityVerdict
): Promise<void> {
  const identity = {
    organizationId: verdict.organizationId,
    githubUserConnectionId: verdict.githubUserConnectionId,
    normalizedTargetOwner: verdict.normalizedTargetOwner,
    targetRepo: verdict.targetRepo,
  };
  const freshness = { checkedAt: { lte: verdict.checkedAt } };
  const data = {
    targetOwner: verdict.targetOwner,
    credentialKind: verdict.credentialKind,
    denialReason: verdict.denialReason,
    installationId: verdict.installationId,
    checkedAt: verdict.checkedAt,
    expiresAt: verdict.expiresAt,
  };
  const updated = await db.gitHubAccessCapability.updateMany({
    where: { ...identity, ...freshness },
    data,
  });
  if (updated.count > 0) {
    return;
  }
  try {
    await db.gitHubAccessCapability.create({ data: { ...identity, ...data } });
  } catch (error) {
    if (getPrismaErrorCode(error) !== "P2002") {
      throw error;
    }
    // Lost the create race. The winner's row may be newer than this verdict,
    // in which case the guarded update matches nothing — by design.
    await db.gitHubAccessCapability.updateMany({
      where: { ...identity, ...freshness },
      data,
    });
  }
}

/**
 * The 401 handler (PLN-1525): set `revokedAt`, mark the sync-pool health
 * `unhealthy`, and drop every capability row for the connection — one
 * transaction on one aggregate, no cross-store consistency gap.
 *
 * The write is a compare-and-set on the credential that actually failed:
 * reconnect replaces `accessTokenEncrypted` on the same connection row, and
 * a late 401 from a client built on the OLD token must not revoke the
 * replacement. When the stored cipher no longer matches (or the row is
 * already revoked), nothing happens — including the capability delete.
 */
export async function markGitHubConnectionRevoked(input: {
  organizationId: string;
  githubUserConnectionId: string;
  /** The encrypted token the failing client was built from (CAS guard). */
  accessTokenEncrypted: string;
  now: Date;
}): Promise<void> {
  await withDb.tx(async (tx) => {
    const revoked = await tx.gitHubUserConnection.updateMany({
      where: {
        id: input.githubUserConnectionId,
        organizationId: input.organizationId,
        revokedAt: null,
        accessTokenEncrypted: input.accessTokenEncrypted,
      },
      data: {
        revokedAt: input.now,
        healthState: GitHubSyncHealthState.Unhealthy,
      },
    });
    if (revoked.count === 0) {
      return;
    }
    await tx.gitHubAccessCapability.deleteMany({
      where: {
        githubUserConnectionId: input.githubUserConnectionId,
        organizationId: input.organizationId,
      },
    });
  });
}

/** One (owner, repo) pair a verdict lookup covers. */
export type GitHubRepoVerdictTarget = { owner: string; repo: string };

/** The verdict columns both the pool and the repo-sync tier reason over. */
export type GitHubRepoVerdictRow = {
  credentialKind: string;
  denialReason: string | null;
  checkedAt: Date;
  expiresAt: Date;
};

/**
 * Prisma `where` fragment selecting ACTIVE verdict rows for the given repos.
 *
 * One definition for every sync-lane carrier: the pool's nested select (one
 * target), the per-repo tier classifier (one target), and the org-wide batch
 * (many). Without this they drift, and a drifted predicate means the pool
 * refuses a credential the tier still counts as covering — the exact thrash
 * ISS-5093 exists to remove.
 *
 * Note the normalization: rows store owner and repo as SEPARATE columns keyed
 * by `normalizeGitHubName`, which is not the same helper as
 * `normalizeRepoFullName`. A caller holding a full name must split it first.
 */
export function activeRepoVerdictWhere(
  targets: readonly GitHubRepoVerdictTarget[],
  now: Date
) {
  return {
    OR: targets.map((target) => ({
      normalizedTargetOwner: normalizeGitHubName(target.owner),
      targetRepo: normalizeGitHubName(target.repo),
    })),
    expiresAt: { gt: now },
  };
}

/**
 * Does this connection hold an active no-access verdict for the target?
 *
 * Verdict rows earned by the OTHER credential family say nothing about this
 * one, so mismatched rows are ignored — the same rule the interactive
 * resolver's `readCachedVerdict` applies.
 */
export function hasActiveNoAccessVerdict(
  rows: readonly GitHubRepoVerdictRow[],
  scopes: readonly string[]
): boolean {
  const kind = storedGitHubCredentialKind(scopes);
  return rows.some(
    (row) => row.credentialKind === kind && row.denialReason !== null
  );
}

/**
 * The same question, but demanding a verdict the SYNC lane wrote.
 *
 * Both lanes write one shared row per (connection, owner, repo) and both stamp
 * `denialReason: no_installation`, so nothing on the row names its author. The
 * only thing that separates them is how long they claim to be true: the
 * interactive resolver writes a 5-minute negative, the sync lane a 6-hour one.
 *
 * That distinction is load-bearing for the tier and only for the tier. Pool
 * exclusion may honour any active verdict — it is re-evaluated every tick and
 * costs one credential one draw. Demoting a repo to `unsyncable` drops it out
 * of the sweep until the wake-up window, so letting a 5-minute interactive blip
 * trigger it would turn a transient 403 into a multi-hour sync outage.
 */
export function hasDurableNoAccessVerdict(
  rows: readonly GitHubRepoVerdictRow[],
  scopes: readonly string[]
): boolean {
  const kind = storedGitHubCredentialKind(scopes);
  return rows.some(
    (row) =>
      row.credentialKind === kind &&
      row.denialReason !== null &&
      row.expiresAt.getTime() - row.checkedAt.getTime() >=
        GITHUB_SYNC_REPO_VERDICT_TTL_MS
  );
}
