import { DocumentStatus } from "@repo/api/src/types/document";
import type { LinearIntegration } from "@repo/database";
import { ArtifactSubtype, ArtifactType, withDb } from "@repo/database";
import {
  type CreateIssueInput,
  createIssues,
  createLinearClient,
  type ExtractedTask,
  exchangeCodeForTokens,
  extractTasksWithLLM,
  formatTaskForLinear,
  getTeams,
  getViewer,
  refreshAccessToken,
  revokeToken,
} from "@repo/linear";
import { parseError } from "@repo/observability/error";
import { log } from "@repo/observability/log";
import {
  encryptTokenPair,
  resolveIntegrationToken,
} from "@/lib/integration-encryption";
import { documentVersionService } from "../../documents/document-version-service";

/**
 * Result types for service operations
 */
export type OAuthCallbackResult =
  | { success: true }
  | { success: false; error: string };

export type TokenRefreshResult =
  | { success: true; accessToken: string }
  | { success: false; error: string };

export type IntegrationStatusResult =
  | {
      success: true;
      connected: true;
      organizationName: string;
      defaultTeamId?: string;
      teams: Array<{ id: string; name: string; key: string }>;
    }
  | { success: true; connected: false };

export type ExportResult =
  | {
      success: true;
      issuesCreated: number;
      issues: Array<{
        linearId: string;
        identifier: string;
        url: string;
        title: string;
      }>;
    }
  | { success: false; error: string; status: 400 | 403 | 404 | 500 | 502 };

/**
 * Calculate token expiration date from expiresIn seconds.
 */
function calculateTokenExpiration(expiresIn?: number): Date | null {
  return expiresIn ? new Date(Date.now() + expiresIn * 1000) : null;
}

/**
 * Get a valid access token for a Linear integration, refreshing if necessary.
 * Updates the database with new tokens on successful refresh.
 *
 * Handles token encryption/decryption automatically:
 * - Decrypts stored tokens before use
 * - Encrypts new tokens before storing
 */
async function ensureValidAccessToken(
  integration: LinearIntegration,
  organizationId: string,
  logPrefix = "[linear]"
): Promise<TokenRefreshResult> {
  const needsRefresh =
    integration.tokenExpiresAt &&
    integration.tokenExpiresAt < new Date() &&
    (integration.refreshTokenEncrypted ?? integration.refreshToken);

  if (!needsRefresh) {
    // Prefer encrypted token on read, fall back to plaintext
    let accessToken: string | null;
    try {
      accessToken = await resolveIntegrationToken(
        integration.accessTokenEncrypted,
        integration.accessToken
      );
    } catch (error) {
      log.warn(`${logPrefix} Decryption failed, falling back to plaintext`, {
        organizationId,
        error: parseError(error),
      });
      accessToken = integration.accessToken;
    }
    if (!accessToken) {
      log.warn(`${logPrefix} Missing access token`, { organizationId });
      return {
        success: false,
        error: "Linear access token is unavailable. Please reconnect Linear.",
      };
    }
    return { success: true, accessToken };
  }

  try {
    const rawRefreshToken = await resolveIntegrationToken(
      integration.refreshTokenEncrypted,
      integration.refreshToken
    );
    if (!rawRefreshToken) {
      log.warn(`${logPrefix} Missing refresh token`, { organizationId });
      return {
        success: false,
        error: "Linear refresh token is unavailable. Please reconnect Linear.",
      };
    }

    const tokens = await refreshAccessToken(rawRefreshToken);

    let encryptedAccessToken: string | null = null;
    let encryptedRefreshToken: string | null = null;
    try {
      const encrypted = await encryptTokenPair(
        tokens.accessToken,
        tokens.refreshToken
      );
      encryptedAccessToken = encrypted.encryptedAccessToken;
      encryptedRefreshToken = encrypted.encryptedRefreshToken;
    } catch (error) {
      log.warn(
        `${logPrefix} Failed to encrypt refreshed tokens, storing plaintext only`,
        {
          organizationId,
          error: parseError(error),
        }
      );
    }

    await withDb((db) =>
      db.linearIntegration.update({
        where: { id: integration.id },
        data: {
          accessToken: tokens.accessToken,
          refreshToken: tokens.refreshToken,
          accessTokenEncrypted: encryptedAccessToken ?? undefined,
          refreshTokenEncrypted: encryptedRefreshToken ?? undefined,
          tokenExpiresAt: calculateTokenExpiration(tokens.expiresIn),
        },
      })
    );

    log.info(`${logPrefix} Refreshed access token`, { organizationId });
    return { success: true, accessToken: tokens.accessToken };
  } catch (error) {
    log.error(`${logPrefix} Failed to refresh token`, {
      organizationId,
      error: parseError(error),
    });
    return {
      success: false,
      error: "Linear token expired. Please reconnect Linear.",
    };
  }
}

/**
 * Linear integration service - handles all business logic and database operations
 */
export const linearService = {
  /**
   * Complete the OAuth callback by exchanging code for tokens and storing the integration.
   * Called by the connect route after the app receives the OAuth callback.
   *
   * @param redirectUri - Must match the redirect_uri used in OAuth initiation
   */
  async completeOAuthCallback(
    code: string,
    codeVerifier: string,
    redirectUri: string,
    organizationId: string,
    clerkUserId: string
  ): Promise<OAuthCallbackResult> {
    try {
      // Exchange authorization code for tokens
      const tokens = await exchangeCodeForTokens(
        code,
        codeVerifier,
        redirectUri
      );

      // Calculate token expiration
      const tokenExpiresAt = calculateTokenExpiration(tokens.expiresIn);

      // Get viewer info and encrypt tokens in parallel (independent operations)
      const client = createLinearClient(tokens.accessToken);
      const [linearOrg, { encryptedAccessToken, encryptedRefreshToken }] =
        await Promise.all([
          getViewer(client),
          encryptTokenPair(tokens.accessToken, tokens.refreshToken).catch(
            (error) => {
              log.warn(
                "[linear/oauth] Failed to encrypt tokens, storing plaintext only",
                {
                  organizationId,
                  error: parseError(error),
                }
              );
              return {
                encryptedAccessToken: null,
                encryptedRefreshToken: null,
              };
            }
          ),
        ]);

      if (!linearOrg) {
        return {
          success: false,
          error: "Failed to get Linear organization info",
        };
      }

      // Upsert the integration record
      await withDb((db) =>
        db.linearIntegration.upsert({
          where: { organizationId },
          create: {
            organizationId,
            accessToken: tokens.accessToken,
            refreshToken: tokens.refreshToken,
            accessTokenEncrypted: encryptedAccessToken ?? undefined,
            refreshTokenEncrypted: encryptedRefreshToken ?? undefined,
            tokenExpiresAt,
            linearOrgId: linearOrg.id,
            linearOrgName: linearOrg.name,
          },
          update: {
            accessToken: tokens.accessToken,
            refreshToken: tokens.refreshToken,
            accessTokenEncrypted: encryptedAccessToken ?? undefined,
            refreshTokenEncrypted: encryptedRefreshToken ?? undefined,
            tokenExpiresAt,
            linearOrgId: linearOrg.id,
            linearOrgName: linearOrg.name,
          },
        })
      );

      log.info("[linear] Connected Linear integration", {
        organizationId,
        linearOrgId: linearOrg.id,
        clerkUserId,
      });

      return { success: true };
    } catch (error) {
      log.error("[linear/oauth/callback] Failed to complete OAuth callback", {
        organizationId,
        clerkUserId,
        error: parseError(error),
      });
      return {
        success: false,
        error: "Failed to complete Linear connection",
      };
    }
  },

  /**
   * Get the Linear integration status for an organization.
   * Returns connection status, organization name, and available teams.
   */
  async getIntegrationStatus(
    organizationId: string
  ): Promise<IntegrationStatusResult> {
    const integration = await withDb((db) =>
      db.linearIntegration.findUnique({
        where: { organizationId },
      })
    );

    if (!integration) {
      return { success: true, connected: false };
    }

    // Get valid access token (refresh if needed)
    const tokenResult = await ensureValidAccessToken(
      integration,
      organizationId,
      "[linear]"
    );

    if (!tokenResult.success) {
      // Token refresh failed - mark as disconnected
      return { success: true, connected: false };
    }

    // Fetch teams from Linear
    const client = createLinearClient(tokenResult.accessToken);
    const teams = await getTeams(client);

    return {
      success: true,
      connected: true,
      organizationName: integration.linearOrgName,
      defaultTeamId: integration.defaultTeamId ?? undefined,
      teams,
    };
  },

  /**
   * Disconnect the Linear integration for an organization.
   * Revokes the access token and deletes the integration record.
   */
  async disconnect(organizationId: string): Promise<void> {
    const integration = await withDb((db) =>
      db.linearIntegration.findUnique({
        where: { organizationId },
      })
    );

    if (!integration) {
      return;
    }

    // Revoke the token (best effort - don't fail if this errors)
    try {
      // Prefer decrypted token; fall back to plaintext for backward compatibility
      // accessToken is non-null: integration.accessToken is always a non-null DB field
      const accessToken = await resolveIntegrationToken(
        integration.accessTokenEncrypted,
        integration.accessToken
      );
      await revokeToken(accessToken as string);
    } catch (error) {
      log.warn("[linear] Failed to revoke token during disconnect", {
        organizationId,
        error: parseError(error),
      });
    }

    // Delete the integration record
    await withDb((db) =>
      db.linearIntegration.delete({
        where: { id: integration.id },
      })
    );

    log.info("[linear] Disconnected Linear integration", {
      organizationId,
      linearOrgId: integration.linearOrgId,
    });
  },

  /**
   * Export an approved implementation plan to Linear as individual issues.
   */
  async exportImplementationPlan(
    documentId: string,
    teamId: string,
    organizationId: string,
    userId: string
  ): Promise<ExportResult> {
    // Fetch the artifact
    const artifact = await withDb((db) =>
      db.artifact.findFirst({
        where: {
          id: documentId,
          type: ArtifactType.DOCUMENT,
          project: { organizationId },
        },
      })
    );

    if (!artifact) {
      return { success: false, error: "Artifact not found", status: 404 };
    }

    // Validate artifact type and status
    if (artifact.subtype !== ArtifactSubtype.IMPLEMENTATION_PLAN) {
      return {
        success: false,
        error: "Only implementation plans can be exported to Linear",
        status: 400,
      };
    }

    if (artifact.status !== DocumentStatus.Approved) {
      return {
        success: false,
        error: "Only approved implementation plans can be exported to Linear",
        status: 400,
      };
    }

    // Fetch latest version content (content is stored in ArtifactVersion, not on artifact)
    const latestVersion = await documentVersionService.getLatest(documentId);
    if (!latestVersion?.content) {
      return {
        success: false,
        error: "Artifact has no content to export",
        status: 400,
      };
    }

    // Get Linear integration
    const integration = await withDb((db) =>
      db.linearIntegration.findUnique({
        where: { organizationId },
      })
    );

    if (!integration) {
      return {
        success: false,
        error: "Linear is not connected. Please connect Linear in settings.",
        status: 400,
      };
    }

    // Get valid access token (refresh if needed)
    const tokenResult = await ensureValidAccessToken(
      integration,
      organizationId,
      "[linear/export]"
    );
    if (!tokenResult.success) {
      return { success: false, error: tokenResult.error, status: 502 };
    }

    // Validate team ownership
    const client = createLinearClient(tokenResult.accessToken);
    const teams = await getTeams(client);
    const teamExists = teams.some((t) => t.id === teamId);

    if (!teamExists) {
      log.warn("[linear/export] Team not found in workspace", {
        userId,
        organizationId,
        teamId,
      });
      return {
        success: false,
        error: "Team not found in your Linear workspace",
        status: 403,
      };
    }

    // Extract tasks using LLM
    let allTasks: ExtractedTask[];
    try {
      allTasks = await extractTasksWithLLM(latestVersion.content);
    } catch (error) {
      log.error("[linear/export] Failed to extract tasks with LLM", {
        userId,
        organizationId,
        documentId,
        error: parseError(error),
      });
      return {
        success: false,
        error: "Failed to extract tasks from implementation plan",
        status: 500,
      };
    }

    // Filter to incomplete tasks only
    const tasks = allTasks.filter((task) => !task.isCompleted);

    if (tasks.length === 0) {
      return {
        success: true,
        issuesCreated: 0,
        issues: [],
      };
    }

    // Prepare and create Linear issues
    const issueInputs: CreateIssueInput[] = tasks.map((task) => {
      const formatted = formatTaskForLinear(task);
      return {
        teamId,
        title: formatted.title,
        description: formatted.description,
      };
    });

    let createdIssues: Array<{
      id: string;
      identifier: string;
      url: string;
      title: string;
    }>;

    try {
      createdIssues = await createIssues(client, issueInputs);
    } catch (error) {
      log.error("[linear/export] Failed to create Linear issues", {
        userId,
        organizationId,
        documentId,
        error: parseError(error),
      });
      return {
        success: false,
        error: "Failed to communicate with Linear API",
        status: 502,
      };
    }

    // Mirror the created Linear issues locally so the export stays idempotent
    // and so subtask state can be read back without round-tripping Linear.
    // PLN-787 re-anchored LinearSubtask from workstreamId to documentId.
    await withDb((db) =>
      db.linearSubtask.createMany({
        data: createdIssues.map((issue) => ({
          organizationId,
          documentId,
          linearId: issue.id,
          linearKey: issue.identifier,
          linearUrl: issue.url,
          title: issue.title,
          isCompleted: false,
        })),
      })
    );

    log.info("[linear/export] Exported implementation plan to Linear", {
      userId,
      organizationId,
      documentId,
      teamId,
      issuesCreated: createdIssues.length,
    });

    return {
      success: true,
      issuesCreated: createdIssues.length,
      issues: createdIssues.map((issue) => ({
        linearId: issue.id,
        identifier: issue.identifier,
        url: issue.url,
        title: issue.title,
      })),
    };
  },
};
