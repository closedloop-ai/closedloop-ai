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
  buildIntegrationTokenColumns,
  resolveEncryptedIntegrationToken,
} from "@/lib/integration-encryption";
import type { OrganizationWriteOutcome } from "@/lib/organization-write-receipt";
import {
  type RecordWriteInTransaction,
  writeRecorded,
} from "@/lib/record-write-in-transaction";
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
  integration: LinearTokenFields,
  organizationId: string,
  logPrefix = "[linear]"
): Promise<TokenRefreshResult> {
  // An expired row with no refresh-token ciphertext still takes the refresh
  // branch, which fails it with the reconnect error rather than serving its
  // expired access token.
  const needsRefresh =
    integration.tokenExpiresAt && integration.tokenExpiresAt < new Date();

  if (!needsRefresh) {
    let accessToken: string | null;
    try {
      accessToken = await resolveEncryptedIntegrationToken(
        integration.accessTokenEncrypted
      );
    } catch (error) {
      // The row HAS a ciphertext and KMS could not open it: a failed read, not
      // a missing credential.
      log.warn(`${logPrefix} Access token decryption failed`, {
        organizationId,
        error: parseError(error),
      });
      accessToken = null;
    }
    if (!accessToken) {
      return {
        success: false,
        error: "Linear access token is unavailable. Please reconnect Linear.",
      };
    }
    return { success: true, accessToken };
  }

  try {
    const rawRefreshToken = await resolveEncryptedIntegrationToken(
      integration.refreshTokenEncrypted
    );
    if (!rawRefreshToken) {
      log.warn(`${logPrefix} Missing refresh token`, { organizationId });
      return {
        success: false,
        error: "Linear refresh token is unavailable. Please reconnect Linear.",
      };
    }

    const tokens = await refreshAccessToken(rawRefreshToken);

    // Linear DOES reissue a refresh token on a refresh — `packages/linear`
    // returns `data.refresh_token` from that response — so a failed encrypt
    // below costs Linear more than it costs Google: the grant Linear just
    // rotated is dropped unstored, and if Linear invalidates the superseded one
    // the row is left holding a dead credential that a reconnect (not a retry)
    // is the only way out of. Storing the rotated token in plaintext is the
    // exposure ISS-5081 exists to close, so this still fails closed.
    // A refresh that reissues no refresh token leaves the stored ciphertext
    // untouched: the builder omits the refresh column.
    const tokenColumns = await buildIntegrationTokenColumns(
      tokens.accessToken,
      tokens.refreshToken
    );

    await withDb((db) =>
      db.linearIntegration.update({
        where: { id: integration.id },
        data: {
          ...tokenColumns,
          tokenExpiresAt: calculateTokenExpiration(tokens.expiresIn),
        },
        select: { id: true },
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
      const [linearOrg, tokenColumns] = await Promise.all([
        getViewer(client),
        buildIntegrationTokenColumns(tokens.accessToken, tokens.refreshToken),
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
            ...tokenColumns,
            tokenExpiresAt,
            linearOrgId: linearOrg.id,
            linearOrgName: linearOrg.name,
          },
          update: {
            ...tokenColumns,
            tokenExpiresAt,
            linearOrgId: linearOrg.id,
            linearOrgName: linearOrg.name,
          },
          select: { id: true },
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
        select: {
          ...LINEAR_TOKEN_SELECT,
          linearOrgName: true,
          defaultTeamId: true,
        },
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
  async disconnect(
    organizationId: string,
    /**
     * Runs on the integration delete's transaction (ISS-12552); the token
     * revoke before it is best effort and outside it.
     */
    recordWrite?: RecordWriteInTransaction<OrganizationWriteOutcome>
  ): Promise<void> {
    const integration = await withDb((db) =>
      db.linearIntegration.findUnique({
        where: { organizationId },
        select: { ...LINEAR_TOKEN_SELECT, linearOrgId: true },
      })
    );

    if (!integration) {
      return;
    }

    // Revoke the token (best effort - don't fail if this errors)
    try {
      // A row with no ciphertext resolves to null. `revokeToken(null)` would
      // no-op and leave a live OAuth grant standing after the local row is
      // gone, so say so rather than casting.
      const accessToken = await resolveEncryptedIntegrationToken(
        integration.accessTokenEncrypted
      );
      if (accessToken) {
        await revokeToken(accessToken);
      } else {
        log.warn("[linear] No token to revoke during disconnect", {
          organizationId,
        });
      }
    } catch (error) {
      log.warn("[linear] Failed to revoke token during disconnect", {
        organizationId,
        error: parseError(error),
      });
    }

    // Delete the integration record
    await writeRecorded(
      recordWrite,
      () =>
        withDb((db) =>
          db.linearIntegration.delete({
            where: { id: integration.id },
          })
        ),
      () => ({ changed: true })
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
    // Fetch the artifact. Scoped on the artifact's own organizationId — the org
    // SSOT (PRD-510 FR13) — and never through the Project relation: an artifact
    // with no project would silently fail that implicit inner join and 404.
    const artifact = await withDb((db) =>
      db.artifact.findFirst({
        where: {
          id: documentId,
          type: ArtifactType.DOCUMENT,
          organizationId,
        },
        // The row is a gate, not a payload: only the two eligibility columns
        // below are read, and the export body comes from `ArtifactVersion`.
        select: { subtype: true, status: true },
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
        select: LINEAR_TOKEN_SELECT,
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

/**
 * The only `LinearIntegration` columns `ensureValidAccessToken` reads (`id`
 * scopes the write-back `update`). As with Google, the columns left behind are
 * credentials — the token ciphertexts and `webhook_secret` — so narrowing keeps
 * them out of the process entirely on every status, disconnect, and export
 * call. Callers needing a descriptive column spread this and add exactly that
 * column.
 */
const LINEAR_TOKEN_SELECT = {
  id: true,
  accessTokenEncrypted: true,
  refreshTokenEncrypted: true,
  tokenExpiresAt: true,
} as const;

/**
 * Derived from the select rather than hand-listed, so a field read inside
 * `ensureValidAccessToken` that is missing from `LINEAR_TOKEN_SELECT` fails
 * `tsc` here instead of arriving as `undefined` at runtime.
 */
type LinearTokenFields = Pick<
  LinearIntegration,
  keyof typeof LINEAR_TOKEN_SELECT
>;
