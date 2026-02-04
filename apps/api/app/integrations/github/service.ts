import type { GitHubIntegrationStatus } from "@repo/api/src/types/github";
import type {
  GitHubInstallation,
  GitHubInstallationRepository,
  GitHubInstallationStatus,
} from "@repo/database";
import { withDb } from "@repo/database";
import { parseError } from "@repo/observability/error";
import { log } from "@repo/observability/log";

/**
 * Input type for upserting installation repositories
 */
export type RepositoryInput = {
  githubRepoId: number;
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
 */
function validateInstallationClaim(
  installation: { organizationId: string | null; status: string },
  targetOrgId: string
): string | null {
  // Block claim if installation is already owned by a different org
  // This prevents users with GitHub access from hijacking another org's installation
  if (
    installation.organizationId &&
    installation.organizationId !== targetOrgId &&
    installation.status === "ACTIVE"
  ) {
    return "This GitHub installation is already connected to another organization";
  }
  return null;
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
          status: "ACTIVE",
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
   * @param installationId - GitHub installation ID (as string from URL params)
   * @param redirectUri - Must match the redirect_uri used in OAuth initiation
   * @param organizationId - Our organization ID to claim the installation
   * @param userId - User ID who is claiming the installation
   */
  async completeOAuthCallback(
    code: string,
    installationId: string,
    redirectUri: string,
    organizationId: string,
    userId: string
  ): Promise<OAuthCallbackResult> {
    try {
      // Import GitHub keys - validated at runtime
      const { keys } = await import("@repo/github/keys");
      const config = keys();

      // Exchange authorization code for user access token
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

      const userAccessToken = tokenData.access_token;

      // Fetch the authenticated GitHub user's info (for sender fields if we create the record)
      const githubUser = await fetchGitHubUser(userAccessToken);

      // Verify user has access to the installation
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
        return {
          success: false,
          error: "Failed to verify installation access",
        };
      }

      const installationsData = (await installationsResponse.json()) as {
        installations?: Array<{ id: number }>;
      };

      const installationIdNumber = Number.parseInt(installationId, 10);
      const hasAccess = installationsData.installations?.some(
        (inst) => inst.id === installationIdNumber
      );

      if (!hasAccess) {
        log.warn("[github/oauth] User does not have access to installation", {
          installationId,
          userId,
        });
        return {
          success: false,
          error: "You do not have access to this installation",
        };
      }

      // Find the installation record, or create it if the webhook hasn't arrived yet
      // This handles the race condition where OAuth callback arrives before webhook
      let installation =
        await this.findInstallationByInstallationId(installationIdNumber);

      if (!installation) {
        log.info(
          "[github/oauth] Installation record not found, fetching from GitHub API",
          { installationId }
        );

        // Fetch installation details from GitHub API using user token
        const installationResponse = await fetch(
          "https://api.github.com/user/installations",
          {
            headers: {
              Accept: "application/vnd.github+json",
              Authorization: `Bearer ${userAccessToken}`,
              "X-GitHub-Api-Version": "2022-11-28",
            },
          }
        );

        if (!installationResponse.ok) {
          log.error("[github/oauth] Failed to fetch installation details", {
            status: installationResponse.status,
            installationId,
          });
          return {
            success: false,
            error: "Failed to fetch installation details",
          };
        }

        const installationsData = (await installationResponse.json()) as {
          installations?: Array<{
            id: number;
            account: { id: number; login: string; type: string };
            permissions: unknown;
            events: unknown;
            repository_selection: string;
          }>;
        };

        const githubInstallation = installationsData.installations?.find(
          (inst) => inst.id === installationIdNumber
        );

        if (!githubInstallation) {
          log.error(
            "[github/oauth] Installation not found in user's installations",
            {
              installationId,
            }
          );
          return {
            success: false,
            error: "Installation not found",
          };
        }

        // Create the installation record (webhook will upsert if it arrives later)
        // Use the authenticated GitHub user as the sender since they initiated the OAuth flow
        installation = await this.upsertInstallation(installationIdNumber, {
          accountId: githubInstallation.account.id,
          accountLogin: githubInstallation.account.login,
          accountType: githubInstallation.account.type,
          senderLogin: githubUser?.login ?? "oauth",
          senderId: githubUser?.id ?? 0,
          status: "PENDING_CLAIM", // Will be set to ACTIVE below
          permissions: githubInstallation.permissions,
          events: githubInstallation.events,
          repositorySelection: githubInstallation.repository_selection,
        });

        log.info("[github/oauth] Created installation record from OAuth flow", {
          installationId: installation.id,
          githubInstallationId: installationIdNumber,
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
        `https://api.github.com/user/installations/${installationId}/repositories`,
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
              githubRepoId: repo.id,
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
          installationId,
        });
      }

      log.info("[github/oauth] Successfully connected GitHub installation", {
        installationId,
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
    installationId: number,
    data: {
      accountId: number;
      accountLogin: string;
      accountType: string;
      senderLogin: string;
      senderId: number;
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
   * Deletes existing repositories and creates new ones atomically.
   */
  syncRepositories(
    installationId: string,
    repositories: RepositoryInput[]
  ): Promise<GitHubInstallationRepository[]> {
    return withDb.tx(async (tx) => {
      await tx.gitHubInstallationRepository.deleteMany({
        where: { installationId },
      });

      if (repositories.length === 0) {
        return [];
      }

      await tx.gitHubInstallationRepository.createMany({
        data: repositories.map((repo) => ({
          installationId,
          githubRepoId: repo.githubRepoId,
          fullName: repo.fullName,
          name: repo.name,
          owner: repo.owner,
          private: repo.private,
        })),
      });

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
      for (const repo of repositories) {
        await tx.gitHubInstallationRepository.upsert({
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
        });
      }

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
   * Find a GitHubInstallation by GitHub's installationId (Int).
   */
  findInstallationByInstallationId(
    installationId: number
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
   * Remove GitHubInstallationRepository records by githubRepoId.
   * Used when repositories are removed from an installation.
   */
  async removeRepositories(
    installationId: string,
    githubRepoIds: number[]
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
    const { deleteInstallation } = await import("@repo/github");
    const result = await deleteInstallation(installation.installationId);

    if (!result.success) {
      log.warn(
        "[github] Failed to uninstall from GitHub, continuing with local disconnect",
        {
          installationId: installation.installationId,
          error: result.error,
        }
      );
      // Continue anyway - we'll mark as REMOVED locally even if GitHub API fails
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
   */
  async getRepositories(
    organizationId: string
  ): Promise<GitHubInstallationRepository[]> {
    const installation = await withDb((db) =>
      db.gitHubInstallation.findFirst({
        where: {
          organizationId,
          status: "ACTIVE",
        },
        include: {
          repositories: true,
        },
      })
    );

    if (!installation) {
      return [];
    }

    return installation.repositories;
  },
};
