import { DocumentStatus } from "@repo/api/src/types/document";
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
import {
  documentService,
  type RecordCreatedArtifact,
} from "@/app/documents/document-service";
import { projectsService } from "@/app/projects/service";
import { mapWithDbConcurrency } from "@/lib/db-fanout";
import {
  buildIntegrationTokenColumns,
  resolveEncryptedIntegrationToken,
} from "@/lib/integration-encryption";
import type { OrganizationWriteOutcome } from "@/lib/organization-write-receipt";
import {
  type RecordWriteInTransaction,
  writeRecorded,
} from "@/lib/record-write-in-transaction";
import { truncateToUtf8Bytes } from "@/lib/truncate-utf8";

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
  integration: GoogleTokenFields,
  organizationId: string,
  logPrefix = "[google]"
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
        error:
          "Google access token is unavailable. Please reconnect Google Drive.",
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
        error:
          "Google refresh token is unavailable. Please reconnect Google Drive.",
      };
    }

    const tokens = await refreshAccessToken(rawRefreshToken);

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

    // Google ordinarily returns NO new refresh token on a refresh; the builder
    // then omits the refresh column and the stored ciphertext stays.
    const tokenColumns = await buildIntegrationTokenColumns(
      tokens.accessToken,
      tokens.refreshToken
    );

    await withDb((db) =>
      db.googleIntegration.update({
        where: { organizationId },
        data: {
          ...tokenColumns,
          tokenExpiresAt,
          lastUsedAt: new Date(),
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
      error: "Google token expired. Please reconnect Google Drive.",
    };
  }
}

// Cap on the markdown stored per imported document, in UTF-8 BYTES. Measured
// in bytes rather than `String.length` so a CJK or emoji-heavy document cannot
// slip through at several times this size — see `truncateToUtf8Bytes`.
//
// Exported for the same reason as `sanitizeErrorForClient` below: the gdrive
// context-attachment route runs the identical import, so this is ONE product
// contract. Re-declaring it there would let a change to the cap apply to only
// one of the two paths. Tests import it too rather than restating the literal.
export const MAX_CONTENT_BYTES = 1024 * 1024; // 1MB

/**
 * Sanitize Google API errors for client display.
 * Maps detailed Google errors to user-friendly messages.
 *
 * Exported because the gdrive context-attachment route runs the identical
 * failure modes (`getDocName` / `exportDocAsMarkdown` / `documentService.create`)
 * and must not put raw googleapis text in a response body: those messages quote
 * the offending credential bare (`ya29.…`), so returning `error.message` ships a
 * live access token to the browser.
 */
export function sanitizeErrorForClient(error: unknown): string {
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
        select: GOOGLE_TOKEN_SELECT,
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

      // Google omits `refresh_token` when the user has already granted consent,
      // the ordinary case on a RECONNECT; the builder then leaves the stored
      // refresh ciphertext untouched.
      const [userInfoResult, tokenColumns] = await Promise.all([
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
        buildIntegrationTokenColumns(tokens.accessToken, tokens.refreshToken),
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
            ...tokenColumns,
            tokenExpiresAt,
          },
          update: {
            googleUserId,
            googleEmail,
            ...tokenColumns,
            tokenExpiresAt,
            lastUsedAt: new Date(),
          },
          select: { id: true },
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
        select: { googleEmail: true },
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
  async disconnect(
    organizationId: string,
    /**
     * Runs on the integration delete's transaction (ISS-12552); the token
     * revoke before it is best effort and outside it.
     */
    recordWrite?: RecordWriteInTransaction<OrganizationWriteOutcome>
  ): Promise<{ success: true }> {
    const integration = await withDb((db) =>
      db.googleIntegration.findUnique({
        where: { organizationId },
        select: { ...GOOGLE_TOKEN_SELECT, googleEmail: true },
      })
    );

    if (!integration) {
      return { success: true };
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
        log.warn("[google] No token to revoke during disconnect", {
          organizationId,
        });
      }
    } catch (error) {
      log.warn("[google] Failed to revoke token during disconnect", {
        organizationId,
        error: parseError(error),
      });
    }

    // Delete the integration record
    await writeRecorded(
      recordWrite,
      () =>
        withDb((db) =>
          db.googleIntegration.delete({
            where: { organizationId },
          })
        ),
      () => ({ changed: true })
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
    userId: string,
    /**
     * Runs on each imported document's create transaction (ISS-12552), so a
     * document whose record cannot be stored is not created.
     */
    recordCreated?: RecordCreatedArtifact
  ): Promise<ImportDocsResult> {
    // Get integration
    const integration = await withDb((db) =>
      db.googleIntegration.findUnique({
        where: { organizationId },
        select: GOOGLE_TOKEN_SELECT,
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

    const artifacts: Array<{
      id: string;
      slug: string;
      title: string;
    }> = [];
    const failures: Array<{ docId: string; docTitle: string; error: string }> =
      [];

    await mapWithDbConcurrency(docs, async (doc) => {
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
        const truncation = truncateToUtf8Bytes(markdown, MAX_CONTENT_BYTES);
        const content = truncation.text;
        if (truncation.truncated) {
          // Message text is a Datadog query key, not prose — the first arg
          // becomes the `message` attribute monitors match on. Cap goes in
          // `maxBytes`, so the value stays sourced from the constant.
          log.warn("[google/import] Truncated doc to 1MB", {
            organizationId,
            docId: doc.id,
            docTitle: doc.name,
            maxBytes: MAX_CONTENT_BYTES,
            originalBytes: truncation.originalByteLength,
            truncatedBytes: truncation.byteLength,
          });
        }

        // Create artifact
        const artifact = await documentService.create(
          organizationId,
          userId,
          {
            projectId,
            type: "PRD",
            status: DocumentStatus.Draft,
            title: doc.name,
            content,
            fileName: `${doc.name}.md`,
          },
          recordCreated
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
    });

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

/**
 * The only `GoogleIntegration` columns `ensureValidAccessToken` reads. Fetching
 * more is not just wasted RETURNING bandwidth: every extra column of this row
 * that reaches the Node process is a credential (the two token ciphertexts are
 * the bulk of the table) sitting in a heap object that any future
 * `log`/`JSON.stringify` of the row would forward wholesale. Callers that need a
 * non-token column spread this and add exactly that column.
 */
const GOOGLE_TOKEN_SELECT = {
  accessTokenEncrypted: true,
  refreshTokenEncrypted: true,
  tokenExpiresAt: true,
} as const;

/**
 * Derived from the select rather than hand-listed, so a field read inside
 * `ensureValidAccessToken` that is missing from `GOOGLE_TOKEN_SELECT` fails
 * `tsc` here instead of arriving as `undefined` at runtime.
 */
type GoogleTokenFields = Pick<
  GoogleIntegration,
  keyof typeof GOOGLE_TOKEN_SELECT
>;
