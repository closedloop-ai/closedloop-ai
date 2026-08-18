import { GitHubCredentialKind } from "@repo/api/src/types/github";
import type { TransactionClient } from "@repo/database";
import { GitHubCapabilityTtlMs } from "@/lib/github/github-access";
import { decryptIntegrationToken } from "@/lib/integration-encryption";

/**
 * PLN-1525: the one shared read of a `GitHubUserConnection` as a usable
 * credential — connection lookup, revocation/expiry policy, token decryption,
 * and sampled `lastUsedAt` — used by both the client resolver
 * (`github-client-resolver.ts`) and the comment-write identity adapter
 * (`apps/api/app/comments/github-identity.ts`).
 */

export type GitHubConnectionCredentialClient = Pick<
  TransactionClient,
  "gitHubUserConnection"
>;

/**
 * Internal denial discriminant. Finer-grained than the shared
 * `GitHubAccessDenialReason` on purpose: the comment-write adapter maps
 * `Revoked`/`Expired`/`DecryptionFailed` to distinct identity-blocker
 * statuses, while the resolver collapses all three to `revoked`.
 */
export const GitHubConnectionCredentialDenial = {
  NotConnected: "not_connected",
  Revoked: "revoked",
  Expired: "expired",
  DecryptionFailed: "decryption_failed",
} as const;
export type GitHubConnectionCredentialDenial =
  (typeof GitHubConnectionCredentialDenial)[keyof typeof GitHubConnectionCredentialDenial];

/** An unexpired capability row folded into the connection read. */
export type GitHubCapabilityRecord = {
  credentialKind: string;
  denialReason: string | null;
  installationId: string | null;
  checkedAt: Date;
  expiresAt: Date;
};

export type GitHubConnectionCredential = {
  connectionId: string;
  organizationId: string;
  userId: string;
  githubUserId: string;
  login: string;
  scopes: string[];
  rateLimitTier: number | null;
  token: string;
  /**
   * The stored cipher this credential was decrypted from — the CAS guard for
   * 401 observation (`markGitHubConnectionRevoked`), so a late failure from
   * a pre-reconnect client cannot revoke the replacement token.
   */
  accessTokenEncrypted: string;
  /** Populated only when `capabilityScope` was requested; otherwise empty. */
  capabilities: GitHubCapabilityRecord[];
};

export type ResolveGitHubConnectionCredentialInput = {
  organizationId: string;
  userId: string;
  now: Date;
  /**
   * When present, folds the unexpired capability read into the same
   * connection query so resolution costs zero additional Postgres queries
   * (PLN-1525 pool-protection rule 2). `normalizedTargetRepo: null` reads
   * the owner-level row (owner-only targets); a repo reads the repo-level
   * row — verdict granularity always matches probe granularity.
   */
  capabilityScope?: {
    normalizedTargetOwner: string;
    normalizedTargetRepo: string | null;
  };
};

export type GitHubConnectionCredentialResult =
  | { ok: true; credential: GitHubConnectionCredential }
  | { ok: false; denial: GitHubConnectionCredentialDenial };

/**
 * `lastUsedAt` is sampled, not written per resolution: its only consumer is
 * GitHub's one-year-unused auto-revocation, which needs day granularity.
 * Writing it on every resolution would become a Postgres write per GitHub
 * operation once the resolver serves every read path (PLN-1525
 * pool-protection rule 3). Trade-off: a revocation racing a fresh
 * resolution is caught by the next 401 instead of the skipped write's
 * `count !== 1` recheck.
 */
export const LAST_USED_AT_SAMPLE_INTERVAL_MS = 5 * 60 * 1000;

const CONNECTION_CREDENTIAL_SELECT = {
  id: true,
  organizationId: true,
  userId: true,
  githubUserId: true,
  login: true,
  accessTokenEncrypted: true,
  revokedAt: true,
  tokenExpiresAt: true,
  scopes: true,
  rateLimitTier: true,
  lastUsedAt: true,
} as const;

export async function resolveGitHubUserConnectionCredential(
  db: GitHubConnectionCredentialClient,
  input: ResolveGitHubConnectionCredentialInput
): Promise<GitHubConnectionCredentialResult> {
  const connection = await readConnection(db, input);
  if (!connection) {
    return { ok: false, denial: GitHubConnectionCredentialDenial.NotConnected };
  }
  if (connection.revokedAt !== null) {
    return { ok: false, denial: GitHubConnectionCredentialDenial.Revoked };
  }
  if (
    connection.tokenExpiresAt &&
    connection.tokenExpiresAt.getTime() <= input.now.getTime()
  ) {
    return { ok: false, denial: GitHubConnectionCredentialDenial.Expired };
  }

  let token: string;
  try {
    token = await decryptIntegrationToken(connection.accessTokenEncrypted);
  } catch {
    return {
      ok: false,
      denial: GitHubConnectionCredentialDenial.DecryptionFailed,
    };
  }

  const sampled = await sampleLastUsedAt(db, connection, input);
  if (!sampled) {
    return { ok: false, denial: GitHubConnectionCredentialDenial.Revoked };
  }

  return {
    ok: true,
    credential: {
      connectionId: connection.id,
      organizationId: connection.organizationId,
      userId: connection.userId,
      githubUserId: connection.githubUserId,
      login: connection.login,
      scopes: connection.scopes,
      rateLimitTier: connection.rateLimitTier,
      token,
      accessTokenEncrypted: connection.accessTokenEncrypted,
      capabilities: connection.capabilities,
    },
  };
}

type ConnectionRow = {
  id: string;
  organizationId: string;
  userId: string;
  githubUserId: string;
  login: string;
  accessTokenEncrypted: string;
  revokedAt: Date | null;
  tokenExpiresAt: Date | null;
  scopes: string[];
  rateLimitTier: number | null;
  lastUsedAt: Date | null;
  capabilities: GitHubCapabilityRecord[];
};

async function readConnection(
  db: GitHubConnectionCredentialClient,
  input: ResolveGitHubConnectionCredentialInput
): Promise<ConnectionRow | null> {
  const where = {
    organizationId_userId: {
      organizationId: input.organizationId,
      userId: input.userId,
    },
  };
  if (!input.capabilityScope) {
    const row = await db.gitHubUserConnection.findUnique({
      where,
      select: CONNECTION_CREDENTIAL_SELECT,
    });
    return row ? { ...row, capabilities: [] } : null;
  }
  return await db.gitHubUserConnection.findUnique({
    where,
    select: {
      ...CONNECTION_CREDENTIAL_SELECT,
      capabilities: {
        where: {
          normalizedTargetOwner: input.capabilityScope.normalizedTargetOwner,
          targetRepo: input.capabilityScope.normalizedTargetRepo,
          expiresAt: { gt: input.now },
          // Interactive freshness is derived from checkedAt, not expiresAt:
          // the sync lane writes 6h expiries into the same rows, and that
          // must not stretch this lane's 15m positive / 5m negative policy.
          // This filter enforces the positive ceiling; readCachedVerdict
          // re-checks negatives at the shorter TTL.
          checkedAt: {
            gt: new Date(input.now.getTime() - GitHubCapabilityTtlMs.Positive),
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
  });
}

/** The scope floor for classic-OAuth-family reads/writes (PLN-1525). */
export const GITHUB_REPO_SCOPE = "repo";

/**
 * The one normalization rule for GitHub owner and repo name segments used in
 * cache/verdict identity (GitHub treats both as case-insensitive). Every
 * lane — interactive resolver and sync pool — must build identity through
 * this so case variants can never mint distinct verdict rows.
 */
export function normalizeGitHubName(segment: string): string {
  return segment.toLowerCase();
}

/**
 * Which credential family a stored connection token belongs to. GitHub App
 * user-to-server token exchanges report an empty `scope`, while the
 * Clerk-bridged OAuth App tokens carry classic scopes — the stored scopes
 * array is the discriminator. Scope-floor checks only apply to the OAuth
 * family; App-token reach is governed by the installation, not scopes.
 */
export function storedGitHubCredentialKind(
  scopes: readonly string[]
): GitHubCredentialKind {
  return scopes.length > 0
    ? GitHubCredentialKind.OauthUser
    : GitHubCredentialKind.GithubAppUser;
}

async function sampleLastUsedAt(
  db: GitHubConnectionCredentialClient,
  connection: Pick<ConnectionRow, "id" | "lastUsedAt">,
  input: ResolveGitHubConnectionCredentialInput
): Promise<boolean> {
  const isFresh =
    connection.lastUsedAt !== null &&
    input.now.getTime() - connection.lastUsedAt.getTime() <
      LAST_USED_AT_SAMPLE_INTERVAL_MS;
  if (isFresh) {
    return true;
  }
  const updated = await db.gitHubUserConnection.updateMany({
    where: {
      id: connection.id,
      organizationId: input.organizationId,
      userId: input.userId,
      revokedAt: null,
    },
    data: { lastUsedAt: input.now },
  });
  return updated.count === 1;
}
