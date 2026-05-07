import type { GoogleIntegration } from "@repo/database";
import { withDb } from "@repo/database";
import {
  exchangeCodeForTokens,
  exportDocAsMarkdown,
  getUserInfo,
  listDocsInFolder,
  refreshAccessToken,
  revokeToken,
} from "@repo/google";
import { parseError } from "@repo/observability/error";
import { log } from "@repo/observability/log";
import pLimit from "p-limit";
import { documentService } from "@/app/documents/document-service";
import { projectsService } from "@/app/projects/service";
import {
  encryptTokenPair,
  resolveIntegrationToken,
} from "@/lib/integration-encryption";

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
  | { success: true; connected: false }
  | { success: true; connected: true; email: string | null }
  | { success: false; error: string };

export type ImportDocsResult =
  | {
      success: true;
      importedCount: number;
      totalDocsInFolder: number;
      artifacts: Array<{
        id: string;
        slug: string;
        title: string;
      }>;
      failures: Array<{
        docId: string;
        docTitle: string;
        error: string;
      }>;
    }
  | { success: false; error: string };
/**
 * Get a valid access token for a Google integration, refreshing if necessary.
 * Updates the database with new tokens on successful refresh.
 *
 * This helper lives in the service layer (not packages/google) because it
 * requires database access for token updates.
 */
export async function ensureValidAccessToken(
  integration: GoogleIntegration,
  organizationId: string,
  logPrefix = "[google]"
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
    return { success: true, accessToken: accessToken as string };
  }

  try {
    const rawRefreshToken = await resolveIntegrationToken(
      integration.refreshTokenEncrypted,
      integration.refreshToken as string
    );

    const tokens = await refreshAccessToken(rawRefreshToken as string);

    const tokenExpiresAt = tokens.expiresIn
      ? new Date(Date.now() + tokens.expiresIn * 1000)
      : new Date(Date.now() + 3_600_000); // 1 hour fallback

    if (!tokens.expiresIn) {
      log.warn(
        `${logPrefix} No expires_in from Google refresh, using 1h default`,
        {
          organizationId,
        }
      );
    }

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
      db.googleIntegration.update({
        where: { organizationId },
        data: {
          accessToken: tokens.accessToken,
          refreshToken: tokens.refreshToken,
          accessTokenEncrypted: encryptedAccessToken ?? undefined,
          refreshTokenEncrypted: encryptedRefreshToken ?? undefined,
          tokenExpiresAt,
          lastUsedAt: new Date(),
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
      error: "Google token expired. Please reconnect Google Drive.",
    };
  }
}

/**
 * Sanitize Google API errors for client display.
 * Maps detailed Google errors to user-friendly messages.
 */
function sanitizeErrorForClient(error: unknown): string {
  const errorMsg = String(error);

  if (errorMsg.includes("Permission denied") || errorMsg.includes("403")) {
    return "Unable to access document (permission denied)";
  }
  if (errorMsg.includes("File not found") || errorMsg.includes("404")) {
    return "Document not found";
  }
  if (
    errorMsg.includes("exportSizeLimitExceeded") ||
    errorMsg.includes("10MB")
  ) {
    return "Document exceeds Google Drive export limit (10MB)";
  }
  if (errorMsg.includes("quotaExceeded") || errorMsg.includes("rate limit")) {
    return "Google API quota exceeded, try again later";
  }

  return "Failed to import document";
}

/**
 * Google integration service - handles all business logic and database operations
 */
export const googleService = {
  /**
   * Fetch the Google integration record for an organization.
   * Returns null if no integration exists.
   */
  getIntegration(organizationId: string) {
    return withDb((db) =>
      db.googleIntegration.findUnique({
        where: { organizationId },
      })
    );
  },

  /**
   * Complete the OAuth callback by exchanging code for tokens and storing the integration.
   * Called by the connect route after the app receives the OAuth callback.
   */
  async completeOAuthCallback(
    code: string,
    codeVerifier: string,
    redirectUri: string,
    organizationId: string
  ): Promise<OAuthCallbackResult> {
    try {
      // Exchange authorization code for tokens
      const tokens = await exchangeCodeForTokens(
        code,
        codeVerifier,
        redirectUri
      );

      // Calculate token expiration with fallback
      const tokenExpiresAt = tokens.expiresIn
        ? new Date(Date.now() + tokens.expiresIn * 1000)
        : new Date(Date.now() + 3_600_000); // 1 hour fallback

      if (!tokens.expiresIn) {
        log.warn("[google/oauth] No expires_in from Google, using 1h default", {
          organizationId,
        });
      }

      // Get user info and encrypt tokens in parallel (independent operations)
      let googleEmail: string | null = null;
      let googleUserId = "unknown"; // Fallback if userinfo fails

      const [userInfoResult, { encryptedAccessToken, encryptedRefreshToken }] =
        await Promise.all([
          getUserInfo(tokens.accessToken).catch((error) => {
            log.warn(
              "[google/oauth] Failed to get user info, continuing without email",
              {
                organizationId,
                error: parseError(error),
              }
            );
            return null;
          }),
          encryptTokenPair(tokens.accessToken, tokens.refreshToken).catch(
            (error) => {
              log.warn(
                "[google/oauth] Failed to encrypt tokens, storing plaintext only",
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

      if (userInfoResult) {
        googleEmail = userInfoResult.email;
        googleUserId = userInfoResult.email; // Use email as stable user ID
      }

      // Upsert the integration record
      await withDb((db) =>
        db.googleIntegration.upsert({
          where: { organizationId },
          create: {
            organizationId,
            googleUserId,
            googleEmail,
            accessToken: tokens.accessToken,
            refreshToken: tokens.refreshToken,
            accessTokenEncrypted: encryptedAccessToken ?? undefined,
            refreshTokenEncrypted: encryptedRefreshToken ?? undefined,
            tokenExpiresAt,
          },
          update: {
            googleUserId,
            googleEmail,
            accessToken: tokens.accessToken,
            refreshToken: tokens.refreshToken,
            accessTokenEncrypted: encryptedAccessToken ?? undefined,
            refreshTokenEncrypted: encryptedRefreshToken ?? undefined,
            tokenExpiresAt,
            lastUsedAt: new Date(),
          },
        })
      );

      log.info("[google] Connected Google integration", {
        organizationId,
        googleEmail,
      });

      return { success: true };
    } catch (error) {
      log.error("[google/oauth/callback] Failed to complete OAuth callback", {
        organizationId,
        error: parseError(error),
      });
      return {
        success: false,
        error: "Failed to complete Google Drive connection",
      };
    }
  },

  /**
   * Get the Google integration status for an organization.
   * Returns connection status and user email.
   *
   * This is a read-only check — no token refresh or lastUsedAt update.
   * Token refresh happens lazily in operations that need a valid token
   * (e.g., importDocsFromFolder) via ensureValidAccessToken().
   */
  async getIntegrationStatus(
    organizationId: string
  ): Promise<IntegrationStatusResult> {
    const integration = await withDb((db) =>
      db.googleIntegration.findUnique({
        where: { organizationId },
      })
    );

    if (!integration) {
      return { success: true, connected: false };
    }

    return {
      success: true,
      connected: true,
      email: integration.googleEmail,
    };
  },

  /**
   * Disconnect the Google integration for an organization.
   * Revokes the access token and deletes the integration record.
   */
  async disconnect(organizationId: string): Promise<{ success: true }> {
    const integration = await withDb((db) =>
      db.googleIntegration.findUnique({
        where: { organizationId },
      })
    );

    if (!integration) {
      return { success: true };
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
      log.warn("[google] Failed to revoke token during disconnect", {
        organizationId,
        error: parseError(error),
      });
    }

    // Delete the integration record
    await withDb((db) =>
      db.googleIntegration.delete({
        where: { organizationId },
      })
    );

    log.info("[google] Disconnected Google integration", {
      organizationId,
      googleEmail: integration.googleEmail,
    });

    return { success: true };
  },

  /**
   * Import all Google Docs from a folder as PRD artifacts.
   * Uses concurrency limiting and per-doc error handling for partial success.
   */
  async importDocsFromFolder(
    folderId: string,
    projectId: string,
    organizationId: string,
    userId: string
  ): Promise<ImportDocsResult> {
    // Get integration
    const integration = await withDb((db) =>
      db.googleIntegration.findUnique({
        where: { organizationId },
      })
    );

    if (!integration) {
      return {
        success: false,
        error: "Google Drive is not connected. Please connect in settings.",
      };
    }

    // Ensure valid access token (refresh if needed)
    const tokenResult = await ensureValidAccessToken(
      integration,
      organizationId,
      "[google/import]"
    );

    if (!tokenResult.success) {
      return { success: false, error: tokenResult.error };
    }

    const accessToken = tokenResult.accessToken;

    // Verify project exists and belongs to organization
    const project = await projectsService.findById(projectId, organizationId);
    if (!project) {
      return {
        success: false,
        error: "Project not found or you don't have access",
      };
    }

    // List docs in folder
    let docs: Array<{ id: string; name: string; mimeType: string }>;
    try {
      docs = await listDocsInFolder(folderId, accessToken);
    } catch (error) {
      log.error("[google/import] Failed to list docs in folder", {
        organizationId,
        folderId,
        error: parseError(error),
      });

      const errorMsg = String(error);
      if (errorMsg.includes("404") || errorMsg.includes("not found")) {
        return { success: false, error: "Folder not found" };
      }
      if (errorMsg.includes("403") || errorMsg.includes("Permission denied")) {
        return {
          success: false,
          error: "Folder not accessible (permission denied)",
        };
      }

      return { success: false, error: "Failed to access Google Drive folder" };
    }

    if (docs.length === 0) {
      log.info("[google/import] No docs found in folder", {
        organizationId,
        folderId,
      });
      return {
        success: true,
        importedCount: 0,
        totalDocsInFolder: 0,
        artifacts: [],
        failures: [],
      };
    }

    // Track total before potential truncation
    const totalDocsInFolder = docs.length;

    // Limit to 100 docs
    if (docs.length > 100) {
      docs = docs.slice(0, 100);
      log.warn("[google/import] Limiting import to 100 docs", {
        organizationId,
        folderId,
        totalDocsInFolder,
      });
    }

    // Import docs with concurrency limit
    const limit = pLimit(5); // 5 parallel imports
    const artifacts: Array<{
      id: string;
      slug: string;
      title: string;
    }> = [];
    const failures: Array<{ docId: string; docTitle: string; error: string }> =
      [];

    const importPromises = docs.map((doc) =>
      limit(async () => {
        try {
          // Export doc as markdown
          let markdown: string;
          try {
            markdown = await exportDocAsMarkdown(doc.id, accessToken);
          } catch (error) {
            const errorMsg = sanitizeErrorForClient(error);
            log.error("[google/import] Failed to export doc", {
              organizationId,
              docId: doc.id,
              docTitle: doc.name,
              error: parseError(error),
            });
            failures.push({
              docId: doc.id,
              docTitle: doc.name,
              error: errorMsg,
            });
            return;
          }

          // Markdown is stored verbatim; the renderer sanitizes at render
          // time (markdown → HTML). HTML-sanitizing raw markdown corrupts URL
          // query strings (`&` → `&amp;`), strips `<https://…>` autolinks, and
          // mangles code blocks that legitimately contain angle brackets.
          const MAX_SIZE = 1024 * 1024; // 1MB
          let content = markdown;
          if (content.length > MAX_SIZE) {
            content = content.substring(0, MAX_SIZE);
            log.warn("[google/import] Truncated doc to 1MB", {
              organizationId,
              docId: doc.id,
              docTitle: doc.name,
              originalSize: markdown.length,
              truncatedSize: content.length,
            });
          }

          // Create artifact
          const artifact = await documentService.create(
            organizationId,
            userId,
            {
              projectId,
              type: "PRD",
              status: "DRAFT",
              title: doc.name,
              content,
              fileName: `${doc.name}.md`,
            }
          );

          if (!artifact) {
            throw new Error("Failed to create artifact (returned null)");
          }

          log.info("[google/import] Imported doc", {
            organizationId,
            docId: doc.id,
            docTitle: doc.name,
            documentId: artifact.id,
          });

          artifacts.push({
            id: artifact.id,
            slug: artifact.slug ?? "",
            title: artifact.title,
          });
        } catch (error) {
          const errorMsg = sanitizeErrorForClient(error);
          log.error("[google/import] Failed to create artifact", {
            organizationId,
            docId: doc.id,
            docTitle: doc.name,
            error: parseError(error),
          });
          failures.push({ docId: doc.id, docTitle: doc.name, error: errorMsg });
        }
      })
    );

    await Promise.all(importPromises);

    log.info("[google/import] Import complete", {
      organizationId,
      folderId,
      projectId,
      importedCount: artifacts.length,
      failedCount: failures.length,
    });

    return {
      success: true,
      importedCount: artifacts.length,
      totalDocsInFolder,
      artifacts,
      failures,
    };
  },
};
