import type {
  GetBranchesResponse,
  GetPullRequestsResponse,
  GitHubIntegrationStatus,
} from "@repo/api/src/types/github";
import type {
  GitHubInstallation,
  GitHubInstallationRepository,
  GitHubInstallationStatus,
} from "@repo/database";
import { withDb } from "@repo/database";
import {
  deleteInstallation,
  getRepositoryBranches,
  getRepositoryPullRequests,
} from "@repo/github";
import { keys } from "@repo/github/keys";
import { parseError } from "@repo/observability/error";
import { log } from "@repo/observability/log";

/**
 * Input type for upserting installation repositories
 */
export type RepositoryInput = {
  githubRepoId: string;
  fullName: string;
  name: string;
  owner: string;
  private: boolean;
};

/**
 * Result type for OAuth callback operations
 */
export type OAuthCallbackResult =
  | { success: true }
  | { success: false; error: string };

/**
 * Fetch the authenticated GitHub user's info using an access token.
 */
async function fetchGitHubUser(
  accessToken: string
): Promise<{ id: number; login: string } | null> {
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

  return response.json() as Promise<{ id: number; login: string }>;
}

/**
 * Check if an installation can be claimed by the given organization.
 * Returns an error message if claim is blocked, null if allowed.
 *
 * Blocks claims when the installation is already owned by a different org,
 * regardless of status (ACTIVE, SUSPENDED, etc.). This prevents hijacking
 * when a GitHub admin suspends an installation but the org link remains.
 * Only UNINSTALLED installations (which have organizationId cleared) can be re-claimed.
 */
function validateInstallationClaim(
  installation: { organizationId: string | null; status: string },
  targetOrgId: string
): string | null {
  // Block claim if installation is already owned by a different org (any status)
  if (
    installation.organizationId &&
    installation.organizationId !== targetOrgId
  ) {
    return "This GitHub installation is already connected to another organization";
  }
  return null;
}

type GitHubRawInstallation = {
  id: number;
  account: { id: number; login: string; type: string };
  permissions: unknown;
  events: unknown;
  repository_selection: string;
};

/**
 * Exchange an OAuth authorization code for a user access token.
 */
async function exchangeCodeForToken(
  code: string,
  redirectUri: string,
  config: { GITHUB_APP_CLIENT_ID: string; GITHUB_APP_CLIENT_SECRET: string }
): Promise<
  { success: true; token: string } | { success: false; error: string }
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

  return { success: true, token: tokenData.access_token };
}

/**
 * Fetch the user's GitHub App installations and resolve which one to use.
 * When installationId is provided, verifies the user has access.
 * When absent (standard OAuth flow), picks from the user's installation list.
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
   * Returns connection status and installation details if connected.
   */
  async getIntegrationStatus(
    organizationId: string
  ): Promise<GitHubIntegrationStatus> {
    const installation = await withDb((db) =>
      db.gitHubInstallation.findFirst({
        where: {
          organizationId,
          status: {
            in: ["ACTIVE", "SUSPENDED"],
          },
        },
        include: {
          repositories: true,
        },
      })
    );

    if (!installation) {
      return { connected: false };
    }

    return {
      connected: true,
      installation: {
        id: installation.id,
        installationId: installation.installationId,
        accountLogin: installation.accountLogin,
        accountType: installation.accountType,
        status: installation.status,
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
        return tokenResult;
      }
      const userAccessToken = tokenResult.token;

      // Fetch the authenticated GitHub user's info (for sender fields if we create the record)
      const githubUser = await fetchGitHubUser(userAccessToken);

      // Resolve installation: verify the provided ID, or pick from user's list
      const resolved = await resolveInstallation(
        userAccessToken,
        installationId,
        userId
      );
      if (!resolved.success) {
        return resolved;
      }
      const resolvedInstallationId = resolved.id;

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

        // Create the installation record (webhook will upsert if it arrives later)
        installation = await this.upsertInstallation(
          String(resolvedInstallationId),
          {
            accountId: String(resolved.info.account.id),
            accountLogin: resolved.info.account.login,
            accountType: resolved.info.account.type,
            senderLogin: githubUser?.login ?? "oauth",
            senderId: String(githubUser?.id ?? 0),
            status: "PENDING_CLAIM", // Will be set to ACTIVE below
            permissions: resolved.info.permissions,
            events: resolved.info.events,
            repositorySelection: resolved.info.repository_selection,
          }
        );

        log.info("[github/oauth] Created installation record from OAuth flow", {
          installationId: installation.id,
          githubInstallationId: resolvedInstallationId,
        });
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
        return { success: false, error: claimError };
      }

      // Claim the installation and link to organization in single update
      await withDb((db) =>
        db.gitHubInstallation.update({
          where: { id: installation.id },
          data: {
            status: "ACTIVE",
            organizationId,
            claimedAt: new Date(),
            claimedByUserId: userId,
          },
        })
      );

      // Fetch and sync repositories
      const reposResponse = await fetch(
        `https://api.github.com/user/installations/${resolvedInstallationId}/repositories`,
        {
          headers: {
            Accept: "application/vnd.github+json",
            Authorization: `Bearer ${userAccessToken}`,
            "X-GitHub-Api-Version": "2022-11-28",
          },
        }
      );

      if (reposResponse.ok) {
        const reposData = (await reposResponse.json()) as {
          repositories?: Array<{
            id: number;
            full_name: string;
            name: string;
            owner: { login: string };
            private: boolean;
          }>;
        };

        if (reposData.repositories && reposData.repositories.length > 0) {
          await this.syncRepositories(
            installation.id,
            reposData.repositories.map((repo) => ({
              githubRepoId: String(repo.id),
              fullName: repo.full_name,
              name: repo.name,
              owner: repo.owner.login,
              private: repo.private,
            }))
          );
        }
      } else {
        log.warn("[github/oauth] Failed to fetch repositories", {
          status: reposResponse.status,
          installationId: resolvedInstallationId,
        });
      }

      log.info("[github/oauth] Successfully connected GitHub installation", {
        installationId: resolvedInstallationId,
        organizationId,
        userId,
      });

      return { success: true };
    } catch (error) {
      log.error("[github/oauth] Failed to complete OAuth callback", {
        installationId,
        organizationId,
        userId,
        error: parseError(error),
      });
      return {
        success: false,
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
   * Sync repositories for an installation.
   * Uses upsert to preserve record IDs and only removes repos no longer in the list.
   */
  syncRepositories(
    installationId: string,
    repositories: RepositoryInput[]
  ): Promise<GitHubInstallationRepository[]> {
    return withDb.tx(async (tx) => {
      // Get the set of GitHub repo IDs we're syncing
      const incomingRepoIds = new Set(repositories.map((r) => r.githubRepoId));

      // Delete repos that are no longer in the installation
      await tx.gitHubInstallationRepository.deleteMany({
        where: {
          installationId,
          githubRepoId: { notIn: [...incomingRepoIds] },
        },
      });

      if (repositories.length === 0) {
        return [];
      }

      // Upsert each repository to preserve IDs
      await Promise.all(
        repositories.map((repo) =>
          tx.gitHubInstallationRepository.upsert({
            where: {
              installationId_githubRepoId: {
                installationId,
                githubRepoId: repo.githubRepoId,
              },
            },
            create: {
              installationId,
              githubRepoId: repo.githubRepoId,
              fullName: repo.fullName,
              name: repo.name,
              owner: repo.owner,
              private: repo.private,
            },
            update: {
              fullName: repo.fullName,
              name: repo.name,
              owner: repo.owner,
              private: repo.private,
            },
          })
        )
      );

      return tx.gitHubInstallationRepository.findMany({
        where: { installationId },
      });
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
      // Upsert each repository (creates if not exists, updates if exists)
      await Promise.all(
        repositories.map((repo) =>
          tx.gitHubInstallationRepository.upsert({
            where: {
              installationId_githubRepoId: {
                installationId,
                githubRepoId: repo.githubRepoId,
              },
            },
            create: {
              installationId,
              githubRepoId: repo.githubRepoId,
              fullName: repo.fullName,
              name: repo.name,
              owner: repo.owner,
              private: repo.private,
            },
            update: {
              fullName: repo.fullName,
              name: repo.name,
              owner: repo.owner,
              private: repo.private,
            },
          })
        )
      );

      // Return the created/updated records
      const githubRepoIds = repositories.map((r) => r.githubRepoId);
      return tx.gitHubInstallationRepository.findMany({
        where: {
          installationId,
          githubRepoId: { in: githubRepoIds },
        },
      });
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
   */
  async findInstallationForRepoFullName(
    organizationId: string,
    fullName: string
  ): Promise<string | null> {
    const repository = await withDb((db) =>
      db.gitHubInstallationRepository.findFirst({
        where: {
          fullName,
          installation: {
            organizationId,
            status: "ACTIVE",
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
   * Remove GitHubInstallationRepository records by githubRepoId.
   * Used when repositories are removed from an installation.
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
      db.gitHubInstallationRepository.deleteMany({
        where: {
          installationId,
          githubRepoId: { in: githubRepoIds },
        },
      })
    );

    log.info("[github] Removed repositories", {
      installationId,
      count: githubRepoIds.length,
      githubRepoIds,
    });
  },

  /**
   * Disconnect an installation from an organization.
   * Also uninstalls the GitHub App from the GitHub side.
   */
  async disconnectInstallation(organizationId: string): Promise<void> {
    const installation = await withDb((db) =>
      db.gitHubInstallation.findFirst({
        where: { organizationId },
      })
    );

    if (!installation) {
      throw new Error("No installation found for organization");
    }

    // Uninstall from GitHub side first
    const result = await deleteInstallation(installation.installationId);

    if (!result.success) {
      log.warn(
        "[github] Failed to uninstall from GitHub, continuing with local disconnect",
        {
          installationId: installation.installationId,
          error: result.error,
        }
      );
      // Continue anyway - we'll mark as UNINSTALLED locally even if GitHub API fails
    }

    // Update our database record
    await withDb((db) =>
      db.gitHubInstallation.update({
        where: { id: installation.id },
        data: {
          status: "UNINSTALLED",
          organizationId: null,
        },
      })
    );

    log.info("[github] Disconnected and uninstalled", {
      installationId: installation.id,
      githubInstallationId: installation.installationId,
      organizationId,
      uninstalledFromGitHub: result.success,
    });
  },

  /**
   * Get repositories for an organization's GitHub installation.
   * Returns all repositories associated with the installation.
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
          status: "ACTIVE",
        },
        include: {
          repositories: {
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
   * Fetches branches via GitHub GraphQL API, sorts by committedDate descending,
   * and pins the default branch at position 0.
   *
   * @param repositoryId - Internal UUID of GitHubInstallationRepository
   * @param organizationId - Organization ID for authorization
   * @param limit - Maximum number of branches to return (default: 20)
   */
  async getBranches(
    repositoryId: string,
    organizationId: string,
    limit = 20
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
      throw new Error("Repository not found");
    }

    // Verify organization ownership
    if (repository.installation.organizationId !== organizationId) {
      throw new Error("Repository does not belong to organization");
    }

    const [owner, name] = repository.fullName.split("/");

    if (!(owner && name)) {
      throw new Error("Invalid repository fullName format");
    }

    try {
      const branches = await getRepositoryBranches(
        repository.installation.installationId,
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
    options?: { limit?: number }
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

    const [owner, name] = repository.fullName.split("/");

    if (!(owner && name)) {
      throw new Error("Invalid repository fullName format");
    }

    try {
      const pullRequests = await getRepositoryPullRequests(
        repository.installation.installationId,
        owner,
        name,
        { state: "all", limit: options?.limit ?? 30 }
      );

      // Find which PR URLs are already tracked as ExternalLinks in this project
      let trackedPrUrls: string[] = [];
      if (projectId) {
        const existingLinks = await withDb((db) =>
          db.externalLink.findMany({
            where: {
              organizationId,
              projectId,
              type: "PULL_REQUEST",
            },
            select: { externalUrl: true },
          })
        );

        const repoPrefix = `https://github.com/${owner}/${name}/pull/`;
        trackedPrUrls = existingLinks
          .map((el) => el.externalUrl)
          .filter((url) => url.startsWith(repoPrefix));
      }

      return { pullRequests, trackedPrUrls };
    } catch (error) {
      log.error("[github/service] Failed to fetch pull requests", {
        repositoryId,
        organizationId,
        error: parseError(error),
      });
      throw new Error("Failed to fetch pull requests from GitHub");
    }
  },
};
