import type {
  GitHubInstallationStatus as ApiGitHubInstallationStatus,
  GetBranchesResponse,
  GetContributorsResponse,
  GetPullRequestsResponse,
  GitHubContributor,
  GitHubIntegrationStatus,
} from "@repo/api/src/types/github";
import { GitHubInstallationStatus as ApiGitHubInstallationStatusValue } from "@repo/api/src/types/github";
import { Result, Status } from "@repo/api/src/types/result";
import type {
  GitHubInstallation,
  GitHubInstallationRepository,
  TransactionClient,
} from "@repo/database";
import { GitHubInstallationStatus, type Prisma, withDb } from "@repo/database";
import {
  deleteInstallation,
  GitHubProviderResultStatus,
  getRepositoryBranches,
  getRepositoryContributors,
} from "@repo/github";
import { getInstallationOctokit } from "@repo/github/installation-auth";
import { keys } from "@repo/github/keys";
import { parseError } from "@repo/observability/error";
import { log } from "@repo/observability/log";
import { waitUntil } from "@vercel/functions";
import { normalizeGitHubLogin } from "@/app/comments/external-authors";
import { projectsService } from "@/app/projects/service";
import { getPrismaErrorCode } from "@/lib/db-utils";
import { GitHubSyncHealthState } from "@/lib/github/github-access";
import {
  createGitHubReadCostObserver,
  type GitHubReadCostRoute,
} from "@/lib/github/github-read-cost-log";
import { reconcileOrgRepoSyncStatesBestEffort } from "@/lib/github/github-repo-sync-state";
import { acquireInstallationClient } from "@/lib/github/installation-client";
import { filterUnclaimedRepositoryWebhookObservations } from "@/lib/github/repository-default-observation-receipt";
import { encryptTokenPair } from "@/lib/integration-encryption";
import { resolveGitHubDataConnectionStatus } from "./data-connection-status";
import { publicRepositoryService } from "./public-repositories/service";
import { persistIncompleteInstallationRepositoryObservation } from "./service/incomplete-repository-observation";
import { fetchInstallationRepositories } from "./service/installation-repositories-fetch";
import { readRepositoryPullRequestsWithAuthority } from "./service/pull-request-list-read";
import { runRepositoryArtifactRelink } from "./service/repository-artifact-relink";
import {
  createRepositoryArtifactRelinkResult,
  emitRepositoryArtifactRelinkFailedMetric,
  RepositoryArtifactRelinkFailureReason,
  RepositoryArtifactRelinkFailureStage,
  RepositoryArtifactRelinkReason,
  type RepositoryArtifactRelinkResult,
} from "./service/repository-relink-telemetry";
import {
  bulkUpsertInstallationRepositories,
  findInstallationRepositoriesByIds,
  type RepositoryInput,
  tombstoneRepositoriesAbsentFrom,
} from "./service/repository-sync";
import { getTrackedPullRequestState } from "./tracked-pull-requests";

/**
 * Canonical repo-input shape lives in the leaf `service/repository-sync.ts`.
 * Re-exported here to preserve the historical `RepositoryInput` public surface
 * of this module.
 */
export type { RepositoryInput } from "./service/repository-sync";

/**
 * Result type for OAuth callback operations.
 *
 * `requires_confirmation` is emitted by the same-vs-different-account
 * detection (PLN-634) when an org reconnects to a GitHub account whose
 * numeric `accountId` differs from the previously connected one. The route
 * returns this payload to the UI so an admin can confirm a destructive
 * cleanup before any state is mutated.
 */
export type OAuthCallbackResult =
  | { status: "connected" }
  | { status: "error"; error: string }
  | {
      status: "requires_confirmation";
      priorAccount: { accountId: string; accountLogin: string };
      newAccount: { accountId: string; accountLogin: string };
      newInstallationId: string;
    };

const TARGET_PULL_REQUEST_MAX_PAGES = 5;
const TARGET_PULL_REQUEST_MAX_ITEMS = 500;

type GitHubOAuthToken = {
  accessToken: string;
  refreshToken: string | null;
  expiresInSeconds: number | null;
  refreshTokenExpiresInSeconds: number | null;
  scopes: string[];
};

type GitHubOAuthUser = {
  id: number;
  login: string;
  node_id?: string | null;
  avatar_url?: string | null;
  html_url?: string | null;
};

const OAUTH_SCOPE_SEPARATOR_PATTERN = /[,\s]+/;

/**
 * Fetch the authenticated GitHub user's info using an access token.
 */
async function fetchGitHubUser(
  accessToken: string
): Promise<GitHubOAuthUser | null> {
  const response = await fetch("https://api.github.com/user", {
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${accessToken}`,
      "X-GitHub-Api-Version": "2022-11-28",
    },
  });

  if (!response.ok) {
    log.warn("[github/oauth] Failed to fetch GitHub user info", {
      status: response.status,
    });
    return null;
  }

  return response.json() as Promise<GitHubOAuthUser>;
}

async function fetchRequiredGitHubUser(
  accessToken: string
): Promise<GitHubOAuthUser> {
  const user = await fetchGitHubUser(accessToken);
  if (!user) {
    throw new Error("Failed to fetch GitHub user info");
  }
  return user;
}

/**
 * Check if an installation can be claimed by the given organization.
 * Returns an error message if claim is blocked, null if allowed.
 *
 * Ownership rules:
 *  - unclaimed (organizationId === null) → claim allowed
 *  - same-org (organizationId === targetOrgId) → claim allowed regardless of
 *    status. Covers idempotent re-claim of an ACTIVE row and re-claim of an
 *    UNINSTALLED row whose org link is preserved across disconnect for the
 *    same-account reconnect path (see disconnectInstallation).
 *  - different-org (organizationId set and ≠ targetOrgId) → claim blocked.
 *    Prevents hijacking when a GitHub admin suspends an installation but the
 *    org link remains, and prevents a fresh installation row from being
 *    claimed for the wrong tenant.
 */
function validateInstallationClaim(
  installation: { organizationId: string | null; status: string },
  targetOrgId: string
): string | null {
  if (
    installation.organizationId &&
    installation.organizationId !== targetOrgId
  ) {
    return "This GitHub installation is already connected to another organization";
  }
  return null;
}

/**
 * Subset of the GitHub `installation` payload we actually persist. Anchored
 * to the Octokit `GET /user/installations` response — the upstream type's
 * `account` is `SimpleUser | Enterprise | null`, so we keep this narrower
 * shape (non-null account, only the fields we read) instead of threading
 * null checks through every call site that builds a Prisma row.
 *
 * Source of truth: Endpoints["GET /user/installations"] in `@octokit/types`.
 */
type GitHubRawInstallation = {
  id: number;
  account: { id: number; login: string; type: string };
  permissions: Prisma.InputJsonValue;
  events: Prisma.InputJsonValue;
  repository_selection: string;
};

function parseOAuthScopes(scope: string | null | undefined): string[] {
  return (scope ?? "")
    .split(OAUTH_SCOPE_SEPARATOR_PATTERN)
    .map((value) => value.trim())
    .filter(Boolean);
}

function expiresAtFromSeconds(
  issuedAt: Date,
  seconds: number | null
): Date | null {
  if (seconds === null) {
    return null;
  }
  return new Date(issuedAt.getTime() + seconds * 1000);
}

function parseExpiresInSeconds(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export async function persistGitHubUserConnection(
  tx: TransactionClient,
  input: {
    organizationId: string;
    userId: string;
    githubUser: GitHubOAuthUser;
    token: GitHubOAuthToken;
    encryptedAccessToken: string;
    encryptedRefreshToken: string | null;
    issuedAt: Date;
  }
): Promise<void> {
  const connectionData = {
    githubUserId: String(input.githubUser.id),
    githubNodeId: input.githubUser.node_id ?? null,
    login: input.githubUser.login,
    normalizedLogin: normalizeGitHubLogin(input.githubUser.login),
    avatarUrl: input.githubUser.avatar_url ?? null,
    profileUrl: input.githubUser.html_url ?? null,
    accessTokenEncrypted: input.encryptedAccessToken,
    refreshTokenEncrypted: input.encryptedRefreshToken,
    tokenExpiresAt: expiresAtFromSeconds(
      input.issuedAt,
      input.token.expiresInSeconds
    ),
    refreshTokenExpiresAt: expiresAtFromSeconds(
      input.issuedAt,
      input.token.refreshTokenExpiresInSeconds
    ),
    scopes: input.token.scopes,
  };

  const connection = await tx.gitHubUserConnection.upsert({
    where: {
      organizationId_userId: {
        organizationId: input.organizationId,
        userId: input.userId,
      },
    },
    create: {
      organizationId: input.organizationId,
      userId: input.userId,
      ...connectionData,
    },
    update: {
      ...connectionData,
      revokedAt: null,
      // PLN-1525: a fresh grant is a fresh credential — health, backoff, and
      // budget state belong to the token it replaces. Without this reset a
      // 401-revoked connection stays `unhealthy` forever after reconnect and
      // the sync pool never draws the new token.
      healthState: GitHubSyncHealthState.Healthy,
      backoffUntil: null,
      windowSpend: 0,
      observedLimit: null,
      observedRemaining: null,
      observedResetAt: null,
    },
    select: { id: true },
  });
  // Capability verdicts were earned by the replaced credential; drop them so
  // the resolver/pool reprobe with the new one instead of trusting stale
  // reach (the family can flip between OAuth and App tokens on reconnect).
  await tx.gitHubAccessCapability.deleteMany({
    where: {
      githubUserConnectionId: connection.id,
      organizationId: input.organizationId,
    },
  });
}

async function claimInstallationAndPersistGitHubUserConnection(input: {
  installationRecordId: string;
  organizationId: string;
  userId: string;
  githubUser: GitHubOAuthUser;
  token: GitHubOAuthToken;
  encryptedAccessToken: string;
  encryptedRefreshToken: string | null;
  issuedAt: Date;
}): Promise<number> {
  return await withDb.tx(async (tx) => {
    const claimResult = await tx.gitHubInstallation.updateMany({
      where: {
        id: input.installationRecordId,
        OR: [
          { organizationId: null },
          { organizationId: input.organizationId },
        ],
      },
      data: {
        status: GitHubInstallationStatus.ACTIVE,
        organizationId: input.organizationId,
        claimedAt: new Date(),
        claimedByUserId: input.userId,
      },
    });

    if (claimResult.count !== 1) {
      return claimResult.count;
    }

    await persistGitHubUserConnection(tx, {
      organizationId: input.organizationId,
      userId: input.userId,
      githubUser: input.githubUser,
      token: input.token,
      encryptedAccessToken: input.encryptedAccessToken,
      encryptedRefreshToken: input.encryptedRefreshToken,
      issuedAt: input.issuedAt,
    });

    return claimResult.count;
  });
}

type ResolvedInstallation = {
  id: number;
  info: GitHubRawInstallation;
};

/**
 * Same-account reconnect path (PLN-634).
 *
 * Reuses the prior UNINSTALLED installation row in place so all dependent
 * UUIDs (TeamRepository, BranchDetail.repositoryId, PullRequestDetail.
 * repositoryId, GitHubInstallationRepository) are preserved across the
 * disconnect/reinstall window.
 *
 * Steps inside a single transaction:
 *  1. Drop a freshly-created row (if any) carrying the new GitHub
 *     installationId — typically created by the `installation.created`
 *     webhook between disconnect and OAuth callback. This frees the
 *     `installationId @unique` slot before step 2.
 *  2. Update the prior row's `installationId` to the new GitHub install ID,
 *     flip status to ACTIVE, refresh GitHub-side fields.
 *  3. Reconcile repositories by `githubRepoId`:
 *     - Upsert each incoming repo (existing rows keep their UUID; fullName
 *       and other fields are refreshed; `removedAt` is cleared if the repo
 *       reappears after a previous tombstone).
 *     - Tombstone each existing repo whose `githubRepoId` is absent from
 *       the new install. We do NOT delete because BranchDetail /
 *       PullRequestDetail rows may still reference the row.
 */
async function reconnectByAccount(input: {
  priorInstallationId: string;
  resolved: ResolvedInstallation;
  organizationId: string;
  userId: string;
  githubUser: GitHubOAuthUser;
  token: GitHubOAuthToken;
  encryptedAccessToken: string;
  encryptedRefreshToken: string | null;
  issuedAt: Date;
  repositories: RepositoryInput[];
}): Promise<void> {
  const newGithubInstallationId = String(input.resolved.id);
  await withDb.tx(async (tx) => {
    // Only drop a fresh PENDING_CLAIM row created by the webhook race. The
    // `organizationId: null` + `status: PENDING_CLAIM` filter guarantees we
    // never delete a row that some other tenant has already claimed or that
    // is in any state other than the transient PENDING_CLAIM the webhook
    // creates. If a sibling row exists in a different state the subsequent
    // update will fail on the `installationId @unique` constraint, surfacing
    // the conflict rather than silently corrupting another org's installation.
    await tx.gitHubInstallation.deleteMany({
      where: {
        installationId: newGithubInstallationId,
        id: { not: input.priorInstallationId },
        organizationId: null,
        status: GitHubInstallationStatus.PENDING_CLAIM,
      },
    });

    await tx.gitHubInstallation.update({
      where: { id: input.priorInstallationId },
      data: {
        installationId: newGithubInstallationId,
        status: GitHubInstallationStatus.ACTIVE,
        claimedAt: new Date(),
        claimedByUserId: input.userId,
        accountLogin: input.resolved.info.account.login,
        accountType: input.resolved.info.account.type,
        senderLogin: input.githubUser?.login ?? "oauth",
        senderId: String(input.githubUser?.id ?? 0),
        permissions: input.resolved.info.permissions,
        events: input.resolved.info.events,
        repositorySelection: input.resolved.info.repository_selection,
        // Any prior different-account confirmation is moot now.
        pendingNewInstallationId: null,
      },
      select: { id: true },
    });

    await persistGitHubUserConnection(tx, {
      organizationId: input.organizationId,
      userId: input.userId,
      githubUser: input.githubUser,
      token: input.token,
      encryptedAccessToken: input.encryptedAccessToken,
      encryptedRefreshToken: input.encryptedRefreshToken,
      issuedAt: input.issuedAt,
    });

    const incomingByRepoId = new Set(
      input.repositories.map((repo) => repo.githubRepoId)
    );

    // ISS-4619: reconcile the full repo list through the shared chunked,
    // set-based upsert (service/repository-sync.ts) instead of one `upsert` per
    // repo. A large org's reconnect can carry thousands of repos; a serialized
    // round trip each blew past Prisma's 5s interactive-tx timeout and rolled
    // the whole reconnect back (P2028), so the in-place installation reuse failed
    // and the org could not reconnect. The helper dedupes by githubRepoId — a
    // fetched page set can repeat a repo, and a single multi-row ON CONFLICT
    // errors on a duplicate conflict key (wongk CR) — and chunks the VALUES list
    // under Postgres's 65,535 bind-parameter ceiling. On conflict the row id is
    // preserved and the removed_at tombstone cleared, mirroring sync/add.
    await bulkUpsertInstallationRepositories(
      tx,
      input.priorInstallationId,
      input.repositories
    );

    const existing = await tx.gitHubInstallationRepository.findMany({
      where: {
        installationId: input.priorInstallationId,
        removedAt: null,
      },
      select: { id: true, githubRepoId: true },
    });
    const tombstoneIds = existing
      .filter((row) => !incomingByRepoId.has(row.githubRepoId))
      .map((row) => row.id);
    if (tombstoneIds.length > 0) {
      await tx.gitHubInstallationRepository.updateMany({
        where: { id: { in: tombstoneIds } },
        data: { removedAt: new Date() },
      });
    }
  });

  log.info("[github/oauth] Reused prior installation in-place", {
    priorInstallationId: input.priorInstallationId,
    newGithubInstallationId,
    organizationId: input.organizationId,
    repositoryCount: input.repositories.length,
  });
}

/**
 * Detect and execute the same-account reconnect path, or surface a
 * pending-confirmation payload for the different-account path (PLN-634).
 * Returns `null` when no prior UNINSTALLED row exists for this org so the
 * caller falls through to the regular claim flow.
 */
async function tryReconnectExistingInstallation(input: {
  organizationId: string;
  userId: string;
  githubUser: GitHubOAuthUser;
  token: GitHubOAuthToken;
  resolved: ResolvedInstallation;
}): Promise<OAuthCallbackResult | null> {
  const priorUninstalled = await withDb((db) =>
    db.gitHubInstallation.findFirst({
      where: {
        organizationId: input.organizationId,
        status: GitHubInstallationStatus.UNINSTALLED,
      },
    })
  );
  if (!priorUninstalled) {
    return null;
  }

  const newAccountId = String(input.resolved.info.account.id);
  const newInstallationId = String(input.resolved.id);
  const sameAccount = priorUninstalled.accountId === newAccountId;
  if (!sameAccount) {
    // Pin the candidate installation server-side so confirm-reset can't be
    // tricked into claiming an attacker-supplied installationId. A fresh
    // OAuth attempt simply overwrites the pinned value.
    await withDb((db) =>
      db.gitHubInstallation.update({
        where: { id: priorUninstalled.id },
        data: { pendingNewInstallationId: newInstallationId },
        select: { id: true },
      })
    );
    log.info("[github/oauth] Detected different-account reconnect", {
      organizationId: input.organizationId,
      priorAccountId: priorUninstalled.accountId,
      newAccountId,
    });
    return {
      status: "requires_confirmation",
      priorAccount: {
        accountId: priorUninstalled.accountId,
        accountLogin: priorUninstalled.accountLogin,
      },
      newAccount: {
        accountId: newAccountId,
        accountLogin: input.resolved.info.account.login,
      },
      newInstallationId,
    };
  }

  const repositoriesResult = await fetchInstallationRepositories(
    input.resolved.id
  );
  if (!repositoriesResult.ok) {
    // Fail closed, including on a PARTIAL walk, and deliberately unlike the
    // sibling claim path below which connects anyway. `reconnectByAccount`
    // reconciles by tombstoning every existing repository absent from this
    // list, so reconciling against a truncated list would mark live
    // repositories removed and break the BranchDetail/PullRequestDetail
    // references this same-account reconnect (PLN-634) exists to preserve.
    // Refusing costs the user a retry; proceeding costs them their history.
    await persistIncompleteInstallationRepositoryObservation(
      priorUninstalled.id,
      repositoriesResult.repositories,
      repositoriesResult.unavailable
    );
    emitRepositoryArtifactRelinkFailedMetric(
      RepositoryArtifactRelinkFailureStage.OAuthReconnect,
      repositoriesResult.error
    );
    return {
      status: "error",
      error:
        repositoriesResult.error ===
        RepositoryArtifactRelinkFailureReason.RepositoryFetchPartial
          ? "GitHub returned an incomplete repository list. Please try reconnecting."
          : "Failed to fetch repositories from GitHub",
    };
  }
  const issuedAt = new Date();
  const { encryptedAccessToken, encryptedRefreshToken } =
    await encryptTokenPair(input.token.accessToken, input.token.refreshToken);
  await reconnectByAccount({
    priorInstallationId: priorUninstalled.id,
    resolved: input.resolved,
    organizationId: input.organizationId,
    userId: input.userId,
    githubUser: input.githubUser,
    token: input.token,
    encryptedAccessToken,
    encryptedRefreshToken,
    issuedAt,
    repositories: repositoriesResult.repositories,
  });
  return { status: "connected" };
}

/**
 * Exchange an OAuth authorization code for a user access token.
 */
async function exchangeCodeForToken(
  code: string,
  redirectUri: string,
  config: { GITHUB_APP_CLIENT_ID: string; GITHUB_APP_CLIENT_SECRET: string }
): Promise<
  { success: true; token: GitHubOAuthToken } | { success: false; error: string }
> {
  const tokenResponse = await fetch(
    "https://github.com/login/oauth/access_token",
    {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        client_id: config.GITHUB_APP_CLIENT_ID,
        client_secret: config.GITHUB_APP_CLIENT_SECRET,
        code,
        redirect_uri: redirectUri,
      }),
    }
  );

  if (!tokenResponse.ok) {
    log.error("[github/oauth] Failed to exchange code for token", {
      status: tokenResponse.status,
      statusText: tokenResponse.statusText,
    });
    return {
      success: false,
      error: "Failed to exchange authorization code for token",
    };
  }

  const tokenData = (await tokenResponse.json()) as {
    access_token?: string;
    refresh_token?: string;
    expires_in?: unknown;
    refresh_token_expires_in?: unknown;
    scope?: string;
    error?: string;
    error_description?: string;
  };

  if (tokenData.error || !tokenData.access_token) {
    log.error("[github/oauth] Token exchange returned error", {
      error: tokenData.error,
      description: tokenData.error_description,
    });
    return {
      success: false,
      error: tokenData.error_description || "Failed to obtain access token",
    };
  }

  return {
    success: true,
    token: {
      accessToken: tokenData.access_token,
      refreshToken: tokenData.refresh_token ?? null,
      expiresInSeconds: parseExpiresInSeconds(tokenData.expires_in),
      refreshTokenExpiresInSeconds: parseExpiresInSeconds(
        tokenData.refresh_token_expires_in
      ),
      scopes: parseOAuthScopes(tokenData.scope),
    },
  };
}

/**
 * Fetch the user's GitHub App installations and resolve which one to use.
 * When installationId is provided, verifies the user has access.
 * When absent (standard OAuth flow), picks from the user's installation list.
 *
 * PLN-1525 step 4 note: this is the ONE deliberate survivor of the
 * `GET /user/installations` retirement. The token here is by construction a
 * GitHub App user-to-server token (freshly exchanged from the App's OAuth
 * code a few lines up in completeOAuthCallback — a Clerk-sourced OAuth App
 * token can never reach this call), and `/user/installations` is the
 * purpose-built endpoint for the anti-forgery check that the callback's
 * `installation_id` really belongs to this user. Revisit only if the connect
 * flow ever accepts tokens from another source.
 */
export async function resolveInstallation(
  userAccessToken: string,
  installationId: string | undefined,
  userId: string
): Promise<
  | { success: true; id: number; info: GitHubRawInstallation }
  | { success: false; error: string }
> {
  const installationsResponse = await fetch(
    "https://api.github.com/user/installations",
    {
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${userAccessToken}`,
        "X-GitHub-Api-Version": "2022-11-28",
      },
    }
  );

  if (!installationsResponse.ok) {
    log.error("[github/oauth] Failed to fetch user installations", {
      status: installationsResponse.status,
    });
    return { success: false, error: "Failed to verify installation access" };
  }

  const installationsData = (await installationsResponse.json()) as {
    installations?: GitHubRawInstallation[];
  };

  const userInstallations = installationsData.installations ?? [];

  if (installationId) {
    const targetId = Number.parseInt(installationId, 10);
    const match = userInstallations.find((inst) => inst.id === targetId);

    if (!match) {
      log.warn("[github/oauth] User does not have access to installation", {
        installationId,
        userId,
      });
      return {
        success: false,
        error: "You do not have access to this installation",
      };
    }

    return { success: true, id: targetId, info: match };
  }

  // Standard OAuth flow -- no installation_id in the callback
  if (userInstallations.length === 0) {
    log.warn("[github/oauth] No installations found for user", { userId });
    return {
      success: false,
      error:
        "No GitHub App installation found. Please install the GitHub App on your organization first.",
    };
  }

  const selected = userInstallations[0];

  if (userInstallations.length > 1) {
    // Multiple installations found. Pick the first one and rely on
    // validateInstallationClaim downstream to block cross-org claims.
    log.warn(
      "[github/oauth] Multiple installations found, using first. Use ?install=true for explicit selection.",
      {
        userId,
        installationCount: userInstallations.length,
        selectedInstallationId: selected.id,
      }
    );
  }

  return { success: true, id: selected.id, info: selected };
}

/**
 * GitHub integration service - handles all business logic and database operations
 */
export const githubService = {
  /**
   * Get the GitHub integration status for an organization.
   * Returns legacy App-installation status plus the additive GitHub data
   * connection predicate used by product-surface gating.
   */
  async getIntegrationStatus(
    organizationId: string,
    userId?: string | null
  ): Promise<GitHubIntegrationStatus> {
    const { githubDataConnection, installation } = await withDb(async (db) => {
      const installationResult = await db.gitHubInstallation.findFirst({
        where: {
          organizationId,
          status: {
            in: [
              GitHubInstallationStatus.ACTIVE,
              GitHubInstallationStatus.SUSPENDED,
            ],
          },
        },
        include: {
          repositories: { where: { removedAt: null } },
        },
      });
      const githubDataConnectionResult =
        await resolveGitHubDataConnectionStatus(db, {
          hasActiveInstallation:
            installationResult?.status === GitHubInstallationStatus.ACTIVE,
          organizationId,
          userId,
        });
      return {
        githubDataConnection: githubDataConnectionResult,
        installation: installationResult,
      };
    });

    if (!installation) {
      return {
        connected: false,
        githubDataConnection,
      };
    }

    return {
      connected: true,
      githubDataConnection,
      installation: {
        id: installation.id,
        installationId: installation.installationId,
        accountLogin: installation.accountLogin,
        accountType: installation.accountType,
        status: installation.status as ApiGitHubInstallationStatus,
        repositorySelection: installation.repositorySelection,
        repositoryCount: installation.repositories.length,
        claimedAt: installation.claimedAt?.toISOString() ?? null,
        createdAt: installation.createdAt.toISOString(),
      },
    };
  },

  /**
   * Complete the OAuth callback by exchanging code for user access token,
   * verifying user access to the installation, claiming the installation,
   * and syncing repositories.
   *
   * @param code - OAuth authorization code from GitHub
   * @param installationId - GitHub installation ID (as string from URL params), or undefined in standard OAuth flow
   * @param redirectUri - Must match the redirect_uri used in OAuth initiation
   * @param organizationId - Our organization ID to claim the installation
   * @param userId - User ID who is claiming the installation
   */
  async completeOAuthCallback(
    code: string,
    installationId: string | undefined,
    redirectUri: string,
    organizationId: string,
    userId: string
  ): Promise<OAuthCallbackResult> {
    try {
      const config = keys();

      // Exchange authorization code for user access token
      const tokenResult = await exchangeCodeForToken(code, redirectUri, config);
      if (!tokenResult.success) {
        return { status: "error", error: tokenResult.error };
      }
      const userAccessToken = tokenResult.token.accessToken;

      // Fetch the authenticated GitHub user's info (for sender fields if we create the record)
      const githubUser = await fetchRequiredGitHubUser(userAccessToken);

      // Resolve installation: verify the provided ID, or pick from user's list
      const resolved = await resolveInstallation(
        userAccessToken,
        installationId,
        userId
      );
      if (!resolved.success) {
        return { status: "error", error: resolved.error };
      }
      const resolvedInstallationId = resolved.id;

      // PLN-634: detect same-vs-different-account reconnect for orgs that
      // previously disconnected. `accountId` is the only stable identifier
      // across reinstalls (installationId churns; accountLogin is renameable).
      const reconnectResult = await tryReconnectExistingInstallation({
        organizationId,
        userId,
        githubUser,
        token: tokenResult.token,
        resolved,
      });
      if (reconnectResult) {
        return reconnectResult;
      }

      // Find the installation record, or create it if the webhook hasn't arrived yet
      // This handles the race condition where OAuth callback arrives before webhook
      let installation = await this.findInstallationByInstallationId(
        String(resolvedInstallationId)
      );

      if (!installation) {
        log.info(
          "[github/oauth] Installation record not found, creating from GitHub API data",
          { installationId: resolvedInstallationId }
        );

        try {
          installation = await withDb((db) =>
            db.gitHubInstallation.create({
              data: {
                installationId: String(resolvedInstallationId),
                accountId: String(resolved.info.account.id),
                accountLogin: resolved.info.account.login,
                accountType: resolved.info.account.type,
                senderLogin: githubUser.login,
                senderId: String(githubUser.id),
                status: GitHubInstallationStatus.PENDING_CLAIM,
                permissions: resolved.info.permissions,
                events: resolved.info.events,
                repositorySelection: resolved.info.repository_selection,
              },
            })
          );
        } catch (error) {
          if (getPrismaErrorCode(error) !== "P2002") {
            throw error;
          }
          const racedInstallation = await this.findInstallationByInstallationId(
            String(resolvedInstallationId)
          );
          if (!racedInstallation) {
            throw error;
          }
          installation = racedInstallation;
        }

        log.info(
          "[github/oauth] Resolved installation record from OAuth flow",
          {
            installationId: installation.id,
            githubInstallationId: resolvedInstallationId,
          }
        );
      }

      // Security check: Block claim if installation is already owned by a different org
      const claimError = validateInstallationClaim(
        installation,
        organizationId
      );
      if (claimError) {
        log.warn(
          "[github/oauth] Attempted to claim installation already owned by another org",
          {
            installationId,
            existingOrgId: installation.organizationId,
            attemptedOrgId: organizationId,
            userId,
          }
        );
        return { status: "error", error: claimError };
      }

      const issuedAt = new Date();
      const { encryptedAccessToken, encryptedRefreshToken } =
        await encryptTokenPair(
          tokenResult.token.accessToken,
          tokenResult.token.refreshToken
        );
      let claimResultCount = 0;

      try {
        // Claim the installation and persist user OAuth identity in one
        // transaction so upsert failures cannot leave a partial claim.
        claimResultCount =
          await claimInstallationAndPersistGitHubUserConnection({
            installationRecordId: installation.id,
            organizationId,
            userId,
            githubUser,
            token: tokenResult.token,
            encryptedAccessToken,
            encryptedRefreshToken,
            issuedAt,
          });
      } catch (error) {
        log.error("[github/oauth] Failed to persist GitHub user connection", {
          installationId,
          organizationId,
          userId,
          error: parseError(error),
        });
        return {
          status: "error",
          error: "Failed to complete GitHub connection",
        };
      }

      if (claimResultCount !== 1) {
        log.warn(
          "[github/oauth] Installation ownership changed before claim completed",
          {
            installationId,
            attemptedOrgId: organizationId,
            userId,
          }
        );
        return {
          status: "error",
          error:
            "This GitHub installation is already connected to another organization",
        };
      }
      const repositoriesResult = await fetchInstallationRepositories(
        resolvedInstallationId
      );
      if (repositoriesResult.ok) {
        if (repositoriesResult.repositories.length > 0) {
          await this.syncRepositories(
            installation.id,
            repositoriesResult.repositories
          );
        }
        // PLN-1535 M1: a GitHub connection just landed (installation claimed +
        // user token stored) and its repos are now synced — re-evaluate this
        // org's per-repo sync tiers, since installation coverage and connectable
        // tokens both just changed. Gated on the repo sync succeeding so tier-1
        // coverage is classified against the freshly-synced repos, not a stale
        // set. Scheduled off the response path (waitUntil): the reconcile is
        // org-wide and must not delay the OAuth callback redirect. Best-effort:
        // a failed reclassify self-heals on the next tick.
        waitUntil(reconcileOrgRepoSyncStatesBestEffort(organizationId));
      } else {
        await persistIncompleteInstallationRepositoryObservation(
          installation.id,
          repositoriesResult.repositories,
          repositoriesResult.unavailable
        );
        emitRepositoryArtifactRelinkFailedMetric(
          RepositoryArtifactRelinkFailureStage.OAuthClaim,
          repositoriesResult.error
        );
      }

      log.info("[github/oauth] Successfully connected GitHub installation", {
        installationId: resolvedInstallationId,
        organizationId,
        userId,
      });

      return { status: "connected" };
    } catch (error) {
      log.error("[github/oauth] Failed to complete OAuth callback", {
        installationId,
        organizationId,
        userId,
        error: parseError(error),
      });
      return {
        status: "error",
        error: "Failed to complete GitHub connection",
      };
    }
  },
  /**
   * Create or update a GitHubInstallation record.
   * Uses upsert by installationId.
   */
  upsertInstallation(
    installationId: string,
    data: {
      accountId: string;
      accountLogin: string;
      accountType: string;
      senderLogin: string;
      senderId: string;
      status?: GitHubInstallationStatus;
      permissions?: unknown;
      events?: unknown;
      repositorySelection?: string;
      organizationId?: string;
    }
  ): Promise<GitHubInstallation> {
    return withDb((db) =>
      db.gitHubInstallation.upsert({
        where: { installationId },
        create: {
          installationId,
          accountId: data.accountId,
          accountLogin: data.accountLogin,
          accountType: data.accountType,
          senderLogin: data.senderLogin,
          senderId: data.senderId,
          status: data.status ?? "PENDING_CLAIM",
          permissions: data.permissions ?? undefined,
          events: data.events ?? undefined,
          repositorySelection: data.repositorySelection,
          organizationId: data.organizationId,
        },
        update: {
          accountId: data.accountId,
          accountLogin: data.accountLogin,
          accountType: data.accountType,
          senderLogin: data.senderLogin,
          senderId: data.senderId,
          status: data.status,
          permissions: data.permissions ?? undefined,
          events: data.events ?? undefined,
          repositorySelection: data.repositorySelection,
          organizationId: data.organizationId,
        },
      })
    );
  },

  /**
   * Update the status field of a GitHubInstallation.
   */
  async updateInstallationStatus(
    installationId: string,
    status: GitHubInstallationStatus,
    metadata?: {
      suspendedAt?: Date | null;
      suspendedBy?: string | null;
      claimedAt?: Date | null;
      claimedByUserId?: string | null;
    }
  ): Promise<GitHubInstallation> {
    try {
      const installation = await withDb((db) =>
        db.gitHubInstallation.update({
          where: { id: installationId },
          data: {
            status,
            ...metadata,
          },
        })
      );

      log.info("[github] Updated installation status", {
        installationId,
        status,
        organizationId: installation.organizationId,
      });

      return installation;
    } catch (error) {
      log.error("[github] Failed to update installation status", {
        installationId,
        status,
        error: parseError(error),
      });
      throw error;
    }
  },

  /**
   * Relink stale Branch View rows to the active credential repository chosen
   * by the resolver, then let callers reload a pinned-active context before
   * running any provider-backed sync writes.
   */
  async relinkBranchViewRepositoryCredential(input: {
    organizationId: string;
    activeRepositoryId: string;
  }): Promise<RepositoryArtifactRelinkResult> {
    const activeRepository = await withDb((db) =>
      db.gitHubInstallationRepository.findFirst({
        where: {
          id: input.activeRepositoryId,
          removedAt: null,
          installation: {
            organizationId: input.organizationId,
            status: GitHubInstallationStatus.ACTIVE,
          },
        },
        select: {
          id: true,
          githubRepoId: true,
          fullName: true,
          installationId: true,
        },
      })
    );
    if (!activeRepository) {
      return createRepositoryArtifactRelinkResult({
        reasons: [RepositoryArtifactRelinkReason.NoActiveRepositories],
      });
    }

    return await runRepositoryArtifactRelink({
      installationId: activeRepository.installationId,
      repositories: [activeRepository],
      expectedOrganizationId: input.organizationId,
      failureStage: RepositoryArtifactRelinkFailureStage.SyncPreflightRelink,
    });
  },

  /**
   * Sync repositories for an installation.
   * Uses upsert to preserve record IDs and tombstones repos no longer in the
   * active installation grant so historical projection FKs stay resolvable.
   */
  syncRepositories(
    installationId: string,
    repositories: RepositoryInput[]
  ): Promise<GitHubInstallationRepository[]> {
    return withDb
      .tx(async (tx) => {
        // Get the set of GitHub repo IDs we're syncing
        const incomingRepoIds = new Set(
          repositories.map((r) => r.githubRepoId)
        );

        // ISS-4618: tombstone repos absent from the incoming set by diffing the
        // installation's current non-removed ids in memory and updating only the
        // difference through chunked `in` statements. The old `notIn:
        // [...incomingRepoIds]` update bound one parameter per incoming id, which
        // overflows Postgres's 65,535 bind-parameter ceiling on a 65k+ grant
        // (shafty023 CR). Semantics are identical — precisely the repos no longer
        // present are tombstoned — and only the delta is written, so a
        // steady-state re-sync writes nothing.
        await tombstoneRepositoriesAbsentFrom(
          tx,
          installationId,
          incomingRepoIds
        );

        if (repositories.length === 0) {
          return [];
        }

        // ISS-4618: preserve IDs via one chunked set-based upsert (shared with
        // addRepositories) instead of a per-row Promise.all(upsert) loop that
        // serialized N round trips on the tx's pinned connection and would
        // P2028-time-out on a large sync batch. Clears removed_at tombstones so
        // a re-added repo becomes visible again (PLN-634).
        const repositoriesToUpsert =
          await filterUnclaimedRepositoryWebhookObservations(
            tx,
            installationId,
            repositories
          );
        await bulkUpsertInstallationRepositories(
          tx,
          installationId,
          repositoriesToUpsert
        );

        const syncedRepositories =
          await tx.gitHubInstallationRepository.findMany({
            where: { installationId, removedAt: null },
          });
        return syncedRepositories;
      })
      .then(async (syncedRepositories) => {
        if (syncedRepositories.length > 0) {
          await runRepositoryArtifactRelink({
            installationId,
            repositories: syncedRepositories,
            failureStage: RepositoryArtifactRelinkFailureStage.SyncRepositories,
          });
        }
        return syncedRepositories;
      });
  },

  /**
   * Add repositories to an installation (without removing existing ones).
   * Uses upsert to handle duplicates gracefully.
   */
  async addRepositories(
    installationId: string,
    repositories: RepositoryInput[]
  ): Promise<GitHubInstallationRepository[]> {
    if (repositories.length === 0) {
      log.info("[github] No repositories to add");
      return [];
    }

    const result = await withDb.tx(async (tx) => {
      // ISS-4618: one chunked set-based upsert (shared with syncRepositories)
      // instead of a per-row Promise.all(upsert) loop that serialized N round
      // trips on the tx's pinned connection and would P2028-time-out on a large
      // `installation_repositories` webhook batch (which GitHub redelivers on
      // failure). Clears removed_at tombstones from a prior disconnect (PLN-634).
      const repositoriesToUpsert =
        await filterUnclaimedRepositoryWebhookObservations(
          tx,
          installationId,
          repositories
        );
      await bulkUpsertInstallationRepositories(
        tx,
        installationId,
        repositoriesToUpsert
      );

      // ISS-4618: read the just-upserted rows through a chunked `in` lookup so
      // no single findMany binds one parameter per repo id — an unbounded
      // `in: [...ids]` list would overflow Postgres's 65,535 bind-parameter
      // ceiling on a large `installation_repositories` webhook batch. Semantics
      // are unchanged: the same rows are returned (ids deduped so a repeated id
      // in the batch can't duplicate a row).
      const githubRepoIds = repositories.map((r) => r.githubRepoId);
      const addedRepositories = await findInstallationRepositoriesByIds(
        tx,
        installationId,
        githubRepoIds
      );
      return addedRepositories;
    });

    await runRepositoryArtifactRelink({
      installationId,
      repositories: result,
      failureStage: RepositoryArtifactRelinkFailureStage.AddRepositories,
    });

    log.info("[github] Added repositories", {
      installationId,
      count: result.length,
    });

    return result;
  },

  /**
   * Find a GitHubInstallation by our internal id.
   */
  findInstallationById(id: string): Promise<GitHubInstallation | null> {
    return withDb((db) =>
      db.gitHubInstallation.findUnique({
        where: { id },
        include: {
          repositories: true,
        },
      })
    );
  },

  /**
   * Find a GitHubInstallation by GitHub's installationId.
   */
  findInstallationByInstallationId(
    installationId: string
  ): Promise<GitHubInstallation | null> {
    return withDb((db) =>
      db.gitHubInstallation.findUnique({
        where: { installationId },
        include: {
          repositories: true,
        },
      })
    );
  },

  /**
   * Find the GitHub installationId for a repository fullName owned by an organization.
   * Skips tombstoned repos (PLN-634) so dispatch never targets a removed repo.
   */
  async findInstallationForRepoFullName(
    organizationId: string,
    fullName: string
  ): Promise<string | null> {
    const repository = await withDb((db) =>
      db.gitHubInstallationRepository.findFirst({
        where: {
          fullName,
          removedAt: null,
          installation: {
            organizationId,
            status: ApiGitHubInstallationStatusValue.Active,
          },
        },
        select: {
          installation: {
            select: {
              installationId: true,
            },
          },
        },
      })
    );

    return repository?.installation.installationId ?? null;
  },

  /**
   * Tombstone GitHubInstallationRepository records by githubRepoId.
   * Used when repositories are removed from an installation. Rows are
   * preserved so historical PR/branch records and pending dirty-scope nudges
   * keep a resolvable repository identity.
   */
  async removeRepositories(
    installationId: string,
    githubRepoIds: string[]
  ): Promise<void> {
    if (githubRepoIds.length === 0) {
      log.info("[github] No repositories to remove");
      return;
    }

    await withDb((db) =>
      db.gitHubInstallationRepository.updateMany({
        where: {
          installationId,
          githubRepoId: { in: githubRepoIds },
          removedAt: null,
        },
        data: {
          removedAt: new Date(),
        },
      })
    );

    log.info("[github] Tombstoned repositories", {
      installationId,
      count: githubRepoIds.length,
      githubRepoIds,
    });
  },

  /**
   * Disconnect an installation from an organization.
   *
   * Marks the installation UNINSTALLED but preserves `organizationId` so a
   * subsequent reconnect from the same GitHub account can reuse the row
   * in-place (see `reconnectByAccount`). Without preservation, the cascade
   * chain GitHubInstallation → GitHubInstallationRepository → TeamRepository
   * (and BranchDetail / PullRequestDetail) would destroy org-level repo
   * configuration and branch/PR history on every disconnect.
   *
   * Idempotent because Settings may send a DELETE from stale cached UI after
   * another tab, webhook, or local repair has already disconnected.
   */
  async disconnectInstallation(organizationId: string): Promise<void> {
    const installation = await withDb((db) =>
      db.gitHubInstallation.findFirst({
        where: { organizationId },
      })
    );

    if (!installation) {
      log.info("[github] No installation found to disconnect", {
        organizationId,
      });
      return;
    }

    const leaseResult = await withDb((db) =>
      db.gitHubInstallation.updateMany({
        where: { id: installation.id, organizationId },
        data: { status: GitHubInstallationStatus.UNINSTALLED },
      })
    );
    if (leaseResult.count !== 1) {
      log.warn("[github] Skipped disconnect because ownership changed", {
        installationId: installation.id,
        githubInstallationId: installation.installationId,
        organizationId,
      });
      return;
    }

    // Uninstall from GitHub only after the org-scoped local transition wins.
    const result = await deleteInstallation(installation.installationId);

    if (!result.success) {
      log.warn(
        "[github] Failed to uninstall from GitHub, continuing with local disconnect",
        {
          installationId: installation.installationId,
          error: result.error,
        }
      );
      // Continue anyway - we've marked UNINSTALLED locally.
    }

    log.info("[github] Disconnected and uninstalled", {
      installationId: installation.id,
      githubInstallationId: installation.installationId,
      organizationId,
      uninstalledFromGitHub: result.success,
    });
  },

  /**
   * Confirm and execute the different-account reset (PLN-634 Phase 3).
   *
   * Runs once the admin has confirmed the destructive cleanup that swaps the
   * org from GitHub account A to account B. Side effects, all in one
   * transaction:
   *  - Delete `TeamRepository` rows for every team in the org.
   *  - Tombstone `GitHubInstallationRepository` rows owned by the prior
   *    installation. Branch / PR repository FKs remain non-null, so old
   *    repository rows stay FK-resolvable while render recovery and explicit
   *    relink paths restore visibility through a live installation generation.
   *  - Clear `organizationId` on the prior `GitHubInstallation` row to
   *    release the `@unique` slot. The row remains in the DB as an orphan.
   *  - Claim the new installation row for the org (mark ACTIVE).
   *  - Wipe `Project.settings.repositoryOverrides` for every project in the
   *    org.
   *  - Emit an audit log line with prior/new account ids and counts.
   *
   * `RepoBootstrapConfig` is intentionally left in place per Q-002 — it is
   * keyed by fullName and degrades naturally if the repo isn't present in
   * the new account.
   */
  confirmDifferentAccountReset(input: {
    organizationId: string;
    userId: string;
  }): Promise<Result<{ confirmed: true }>> {
    return withDb.tx<Result<{ confirmed: true }>>(async (tx) => {
      const prior = await tx.gitHubInstallation.findFirst({
        where: {
          organizationId: input.organizationId,
          status: GitHubInstallationStatus.UNINSTALLED,
        },
      });
      if (!prior) {
        log.warn("[github/reset] No prior UNINSTALLED installation found", {
          organizationId: input.organizationId,
        });
        return Result.err(Status.BadRequest);
      }
      // Read the installation to claim from the prior row, not from the
      // request body. The OAuth callback pins this value when it detects the
      // mismatch, so a phished admin posting a crafted body cannot redirect
      // the claim to an attacker-owned installation.
      if (!prior.pendingNewInstallationId) {
        log.warn(
          "[github/reset] No pending new installation pinned on prior row",
          {
            organizationId: input.organizationId,
            priorInstallationId: prior.id,
          }
        );
        return Result.err(Status.BadRequest);
      }

      const newInstall = await tx.gitHubInstallation.findUnique({
        where: { installationId: prior.pendingNewInstallationId },
      });
      if (!newInstall) {
        log.warn("[github/reset] Pinned new installation not found", {
          organizationId: input.organizationId,
          pendingNewInstallationId: prior.pendingNewInstallationId,
        });
        return Result.err(Status.BadRequest);
      }
      if (newInstall.accountId === prior.accountId) {
        log.warn(
          "[github/reset] Reset called with same-account install; reject",
          {
            organizationId: input.organizationId,
            accountId: prior.accountId,
          }
        );
        return Result.err(Status.BadRequest);
      }
      if (
        newInstall.organizationId &&
        newInstall.organizationId !== input.organizationId
      ) {
        log.warn(
          "[github/reset] New installation already claimed by another org",
          {
            organizationId: input.organizationId,
            newInstallationOrgId: newInstall.organizationId,
          }
        );
        return Result.err(Status.Forbidden);
      }

      const teamReposDeleted = await tx.teamRepository.deleteMany({
        where: { team: { organizationId: input.organizationId } },
      });

      // Tombstone all repos previously linked to this installation row.
      // `installationId` here is the FK to GitHubInstallation.id (UUID),
      // not the GitHub App installation ID string.
      await tx.gitHubInstallationRepository.updateMany({
        where: { installationId: prior.id, removedAt: null },
        data: { removedAt: new Date() },
      });

      // Releasing the @unique(organizationId) slot must happen before we
      // claim the new row for the same org. Clearing pendingNewInstallationId
      // here prevents a second confirm-reset call from re-firing this flow.
      await tx.gitHubInstallation.update({
        where: { id: prior.id },
        data: { organizationId: null, pendingNewInstallationId: null },
        select: { id: true },
      });

      await tx.gitHubInstallation.update({
        where: { id: newInstall.id },
        data: {
          organizationId: input.organizationId,
          status: GitHubInstallationStatus.ACTIVE,
          claimedAt: new Date(),
          claimedByUserId: input.userId,
        },
        select: { id: true },
      });

      // Sibling-service call — joins the outer transaction via
      // AsyncLocalStorage so the wipe is atomic with the installation swap.
      const projectsCleared =
        await projectsService.clearRepositorySettingsForOrganization(
          input.organizationId
        );

      log.info("[github/reset] Different-account reset completed", {
        organizationId: input.organizationId,
        userId: input.userId,
        priorAccountId: prior.accountId,
        priorAccountLogin: prior.accountLogin,
        newAccountId: newInstall.accountId,
        newAccountLogin: newInstall.accountLogin,
        priorInstallationId: prior.id,
        newInstallationId: newInstall.id,
        teamRepositoriesDeleted: teamReposDeleted.count,
        projectsWithOverridesCleared: projectsCleared,
      });

      return Result.ok({ confirmed: true as const });
    });
  },

  /**
   * Get repositories for an organization's GitHub installation.
   * Returns active repositories associated with the installation.
   * Tombstoned rows (PLN-634) are filtered out so they no longer appear in
   * pickers or pool queries, while remaining FK-resolvable for branch/PR
   * history.
   *
   * @param organizationId - Organization ID to scope the query
   * @param orderBy - Optional sort order (default: lastPushedAt desc with nulls last, then name asc)
   */
  async getRepositories(
    organizationId: string,
    orderBy?: Array<{
      lastPushedAt?: { sort: "asc" | "desc"; nulls?: "first" | "last" };
      name?: "asc" | "desc";
    }>
  ): Promise<GitHubInstallationRepository[]> {
    const installation = await withDb((db) =>
      db.gitHubInstallation.findFirst({
        where: {
          organizationId,
          status: ApiGitHubInstallationStatusValue.Active,
        },
        include: {
          repositories: {
            where: { removedAt: null },
            orderBy: orderBy ?? [
              { lastPushedAt: { sort: "desc", nulls: "last" } },
              { name: "asc" },
            ],
          },
        },
      })
    );

    if (!installation) {
      return [];
    }

    return installation.repositories;
  },

  /**
   * Get branches for a GitHub repository.
   * Fetches installation-backed repos via GitHub GraphQL and falls back to the
   * public-repository store for repos added without an installation.
   *
   * @param repositoryId - Internal UUID of GitHubInstallationRepository
   * @param organizationId - Organization ID for authorization
   * @param limit - Maximum number of branches to return (default: 20)
   * @param allowPublicFallback - When false, a non-installation (public)
   *   repository id is treated as not found instead of resolving via the
   *   public-repository store. User-facing callers pass the
   *   `public-github-repos` flag here so a bookmarked/cached public repo id
   *   cannot reach the dark-launched public path outside the rollout (FEA-2764).
   */
  async getBranches(
    repositoryId: string,
    organizationId: string,
    limit = 20,
    allowPublicFallback = true
  ): Promise<GetBranchesResponse> {
    // Look up the repository and its installation
    const repository = await withDb((db) =>
      db.gitHubInstallationRepository.findFirst({
        where: {
          id: repositoryId,
        },
        include: {
          installation: true,
        },
      })
    );

    if (!repository) {
      if (!allowPublicFallback) {
        // Fail closed: mirror an unknown repository id so the public-repo path
        // stays unreachable when the flag is disabled for this principal.
        throw new Error("Repository not found");
      }
      return publicRepositoryService.getBranches(
        repositoryId,
        organizationId,
        limit
      );
    }

    // Verify organization ownership
    if (repository.installation.organizationId !== organizationId) {
      throw new Error("Repository does not belong to organization");
    }

    assertActiveGitHubRepository(repository);

    const [owner, name] = repository.fullName.split("/");

    if (!(owner && name)) {
      throw new Error("Invalid repository fullName format");
    }

    try {
      const branches = await getRepositoryBranches(
        await getInstallationOctokit(repository.installation.installationId),
        owner,
        name,
        limit
      );

      return { branches };
    } catch (error) {
      log.error("[github/service] Failed to fetch branches", {
        repositoryId,
        fullName: repository.fullName,
        error: parseError(error),
      });
      throw new Error("Failed to fetch branches from GitHub");
    }
  },

  /**
   * Fetch pull requests from GitHub for a repository.
   * Also returns which PR URLs are already tracked as ExternalLinks in the given project.
   */
  async getPullRequests(
    repositoryId: string,
    organizationId: string,
    projectId: string | null,
    options?: { limit?: number },
    // Optional caller-owned route label for GraphQL cost measurement.
    costRoute?: GitHubReadCostRoute
  ): Promise<GetPullRequestsResponse> {
    const repository = await withDb((db) =>
      db.gitHubInstallationRepository.findFirst({
        where: { id: repositoryId },
        include: { installation: true },
      })
    );

    if (!repository) {
      throw new Error("Repository not found");
    }

    if (repository.installation.organizationId !== organizationId) {
      throw new Error("Repository does not belong to organization");
    }

    assertActiveGitHubRepository(repository);

    const [owner, name] = repository.fullName.split("/");

    if (!(owner && name)) {
      throw new Error("Invalid repository fullName format");
    }

    try {
      const tracked = await getTrackedPullRequestState({
        organizationId,
        projectId,
        repositoryFullName: repository.fullName,
        repositoryId: repository.id,
      });
      const targetNumbers = tracked.trackedPrNumbers;
      const pullRequests = await readRepositoryPullRequestsWithAuthority(
        await getInstallationOctokit(repository.installation.installationId),
        owner,
        name,
        {
          state: "all",
          limit: options?.limit ?? 30,
          maxItems:
            targetNumbers.length > 0
              ? TARGET_PULL_REQUEST_MAX_ITEMS
              : undefined,
          maxPages:
            targetNumbers.length > 0
              ? TARGET_PULL_REQUEST_MAX_PAGES
              : undefined,
          targetNumbers,
        },
        costRoute
          ? createGitHubReadCostObserver({
              route: costRoute,
              organizationId,
              repositoryId: repository.id,
              repositoryFullName: repository.fullName,
            })
          : undefined
      );

      return {
        pullRequests: pullRequests.pullRequests,
        hasMore: pullRequests.hasMore,
        truncated: pullRequests.truncated,
        pageInfo: pullRequests.pageInfo,
        stopReason: pullRequests.stopReason,
        missingTargetNumbers: pullRequests.missingTargetNumbers,
        trackedPrUrls: tracked.trackedPrUrls,
        trackedBranches: tracked.trackedBranches,
        trackedBranchKeys: tracked.trackedBranchKeys,
      };
    } catch (error) {
      log.error("[github/service] Failed to fetch pull requests", {
        repositoryId,
        organizationId,
        error: parseError(error),
      });
      throw new Error("Failed to fetch pull requests from GitHub");
    }
  },

  /**
   * Fetch contributors aggregated across all connected repositories for an organization.
   * Deduplicates contributors by GitHub login, summing contribution counts across
   * all repositories the contributor appears in.
   */
  async getContributorsAcrossRepos(
    organizationId: string,
    options?: { maxRepos?: number; perRepoLimit?: number }
  ): Promise<GetContributorsResponse> {
    const maxRepos = options?.maxRepos ?? 10;
    const perRepoLimit = options?.perRepoLimit ?? 30;

    const installation = await withDb((db) =>
      db.gitHubInstallation.findFirst({
        where: { organizationId, status: GitHubInstallationStatus.ACTIVE },
        include: {
          repositories: {
            where: { removedAt: null },
            orderBy: [
              { lastPushedAt: { sort: "desc", nulls: "last" } },
              { name: "asc" },
            ],
            take: maxRepos,
          },
        },
      })
    );

    if (!installation || installation.repositories.length === 0) {
      return { contributors: [] };
    }

    // One installation client shared by every per-repo contributor read
    // (PLN-1525: resolve once per operation, thread down). A failed
    // acquisition degrades to the empty list, matching the per-repo reads'
    // own return-empty-on-error contract.
    const acquired = await acquireInstallationClient(
      installation.installationId
    );
    if (acquired.status !== GitHubProviderResultStatus.Success) {
      log.warn("[github/contributors] Installation client mint failed", {
        installationId: installation.installationId,
        organizationId,
        status: acquired.status,
      });
      return { contributors: [] };
    }
    const octokit = acquired.value;

    const perRepoResults = await Promise.all(
      installation.repositories.map((repo) =>
        getRepositoryContributors(octokit, repo.owner, repo.name, {
          perPage: perRepoLimit,
        })
      )
    );

    const byLogin = new Map<string, GitHubContributor>();
    for (const list of perRepoResults) {
      for (const contributor of list) {
        const existing = byLogin.get(contributor.login);
        if (!existing) {
          byLogin.set(contributor.login, contributor);
          continue;
        }
        byLogin.set(contributor.login, {
          login: contributor.login,
          avatarUrl: existing.avatarUrl || contributor.avatarUrl,
          contributions: existing.contributions + contributor.contributions,
          htmlUrl: existing.htmlUrl || contributor.htmlUrl,
        });
      }
    }

    const contributors = [...byLogin.values()].sort(
      (a, b) => b.contributions - a.contributions
    );

    return { contributors };
  },
};

type ActiveGitHubRepositoryInput = {
  removedAt: Date | null;
  installation: {
    status: GitHubInstallationStatus;
  };
};

function assertActiveGitHubRepository(
  repository: ActiveGitHubRepositoryInput
): void {
  if (
    repository.removedAt !== null ||
    repository.installation.status !== GitHubInstallationStatus.ACTIVE
  ) {
    throw new Error("Repository not found");
  }
}
