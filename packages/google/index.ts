import "server-only";
import { parseError } from "@repo/observability/error";
import { log } from "@repo/observability/log";
import { google } from "googleapis";
import { z } from "zod";
import { keys } from "./keys";

// Lazy config getter - only validates when actually called at runtime
let _config: ReturnType<typeof keys> | null = null;
function getConfig() {
  if (!_config) {
    _config = keys();
  }
  return _config;
}

/**
 * Get required Google credentials, throwing if not configured.
 * Use this in functions that require Google to be configured.
 */
function getRequiredCredentials(): {
  clientId: string;
  clientSecret: string;
} {
  const config = getConfig();
  if (!(config.GOOGLE_CLIENT_ID && config.GOOGLE_CLIENT_SECRET)) {
    throw new Error(
      "Google integration not configured. Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET."
    );
  }
  return {
    clientId: config.GOOGLE_CLIENT_ID,
    clientSecret: config.GOOGLE_CLIENT_SECRET,
  };
}

// =============================================================================
// Types
// =============================================================================

export type GoogleTokens = {
  accessToken: string;
  refreshToken?: string;
  expiresIn?: number;
  tokenType: string;
  scope: string[];
};

export type PKCEChallenge = {
  codeVerifier: string;
  codeChallenge: string;
  codeChallengeMethod: "S256";
};

export type GoogleDriveFile = {
  id: string;
  name: string;
  mimeType: string;
};

export type GoogleUserInfo = {
  email: string;
  name?: string;
  picture?: string;
};

// =============================================================================
// Constants
// =============================================================================

const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const GOOGLE_REVOKE_URL = "https://oauth2.googleapis.com/revoke";
const GOOGLE_USERINFO_URL = "https://www.googleapis.com/oauth2/v2/userinfo";
export const GOOGLE_DOCS_MIME_TYPE = "application/vnd.google-apps.document";

// =============================================================================
// OAuth Functions
// =============================================================================

/**
 * Redact potential tokens from error messages.
 * Matches strings that look like OAuth tokens (40+ chars without spaces/punctuation).
 * Uses a higher threshold (40+) to avoid redacting error codes, URLs, and descriptions
 * which are needed for debugging (e.g., "redirect_uri_mismatch", long URLs).
 */
function redactTokensFromError(errorText: string): string {
  return errorText.replace(/[a-zA-Z0-9_-]{40,}/g, "[REDACTED]");
}

/**
 * Zod schema for validating Google OAuth token responses.
 * Ensures the response from Google's token endpoint matches expected structure.
 */
const googleTokenResponseSchema = z.object({
  access_token: z.string(),
  refresh_token: z.string().optional(),
  expires_in: z.number().optional(),
  token_type: z.string(),
  scope: z.string().optional(),
});

/**
 * Generate a PKCE code verifier and challenge.
 * Uses cryptographically secure random bytes and SHA-256 hashing.
 */
export async function generatePKCE(): Promise<PKCEChallenge> {
  // Generate a random 32-byte code verifier (encoded as base64url, ~43 chars)
  const randomBytes = new Uint8Array(32);
  crypto.getRandomValues(randomBytes);

  // Convert to base64url encoding
  const codeVerifier = btoa(String.fromCharCode(...randomBytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=/g, "");

  // Generate SHA-256 hash of the verifier
  const encoder = new TextEncoder();
  const data = encoder.encode(codeVerifier);
  const hashBuffer = await crypto.subtle.digest("SHA-256", data);

  // Convert hash to base64url encoding
  const hashArray = new Uint8Array(hashBuffer);
  const codeChallenge = btoa(String.fromCharCode(...hashArray))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=/g, "");

  return {
    codeVerifier,
    codeChallenge,
    codeChallengeMethod: "S256",
  };
}

/**
 * Exchange an authorization code for tokens.
 * Called by the API after the app receives the OAuth callback.
 */
export async function exchangeCodeForTokens(
  code: string,
  codeVerifier: string,
  redirectUri: string
): Promise<GoogleTokens> {
  const { clientId, clientSecret } = getRequiredCredentials();

  try {
    const response = await fetch(GOOGLE_TOKEN_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        client_id: clientId,
        client_secret: clientSecret,
        redirect_uri: redirectUri,
        code,
        code_verifier: codeVerifier,
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      log.error("[google/oauth] Token exchange failed", {
        status: response.status,
        error: redactTokensFromError(errorText),
      });
      throw new Error(`Token exchange failed: ${response.status}`);
    }

    const json = await response.json();
    const data = googleTokenResponseSchema.parse(json);

    return {
      accessToken: data.access_token,
      refreshToken: data.refresh_token,
      expiresIn: data.expires_in,
      tokenType: data.token_type,
      scope: data.scope?.split(" ") ?? [],
    };
  } catch (error) {
    log.error("[google/oauth] Token exchange error", {
      error: parseError(error),
    });
    throw error;
  }
}

/**
 * Refresh an access token using a refresh token.
 */
export async function refreshAccessToken(
  refreshToken: string
): Promise<GoogleTokens> {
  const { clientId, clientSecret } = getRequiredCredentials();

  try {
    const response = await fetch(GOOGLE_TOKEN_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        client_id: clientId,
        client_secret: clientSecret,
        refresh_token: refreshToken,
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      log.error("[google/oauth] Token refresh failed", {
        status: response.status,
        error: redactTokensFromError(errorText),
      });
      throw new Error(`Token refresh failed: ${response.status}`);
    }

    const json = await response.json();
    const data = googleTokenResponseSchema.parse(json);

    return {
      accessToken: data.access_token,
      refreshToken: data.refresh_token,
      expiresIn: data.expires_in,
      tokenType: data.token_type,
      scope: data.scope?.split(" ") ?? [],
    };
  } catch (error) {
    // Log and re-throw to preserve error handling upstream
    log.error("[google/oauth] Token refresh error", {
      error: parseError(error),
    });
    throw error;
  }
}

/**
 * Revoke an access token (for disconnecting integration).
 */
export async function revokeToken(accessToken: string): Promise<void> {
  try {
    const response = await fetch(GOOGLE_REVOKE_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        token: accessToken,
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      log.warn("[google/oauth] Token revocation failed (continuing anyway)", {
        status: response.status,
        error: errorText,
      });
    }
  } catch (error) {
    // Best effort - log but don't throw
    log.warn("[google/oauth] Token revocation error (continuing anyway)", {
      error: parseError(error),
    });
  }
}

// =============================================================================
// Google Drive API Operations
// =============================================================================

/**
 * List Google Docs in a specific folder.
 * Returns up to 100 documents that are not trashed.
 */
export async function listDocsInFolder(
  folderId: string,
  accessToken: string
): Promise<GoogleDriveFile[]> {
  try {
    const drive = google.drive({ version: "v3", auth: accessToken });

    const response = await drive.files.list({
      q: `'${folderId}' in parents and mimeType='${GOOGLE_DOCS_MIME_TYPE}' and trashed=false`,
      pageSize: 100,
      fields: "files(id, name, mimeType)",
    });

    const files = response.data.files || [];
    return files.map((file) => ({
      id: file.id!,
      name: file.name!,
      mimeType: file.mimeType!,
    }));
  } catch (error) {
    log.error("[google/drive] Failed to list docs in folder", {
      folderId,
      error: parseError(error),
    });
    throw error;
  }
}

/**
 * Export a Google Doc as markdown.
 * Returns the markdown content as a string.
 */
export async function exportDocAsMarkdown(
  docId: string,
  accessToken: string
): Promise<string> {
  try {
    const drive = google.drive({ version: "v3", auth: accessToken });

    const response = await drive.files.export(
      {
        fileId: docId,
        mimeType: "text/markdown",
      },
      {
        responseType: "text",
      }
    );

    return response.data as string;
  } catch (error) {
    log.error("[google/drive] Failed to export doc as markdown", {
      docId,
      error: parseError(error),
    });
    throw error;
  }
}

/**
 * Get the name of a Google Drive file by its ID.
 * Returns the file name, or null if it cannot be retrieved.
 */
export async function getDocName(
  docId: string,
  accessToken: string
): Promise<string | null> {
  try {
    const drive = google.drive({ version: "v3", auth: accessToken });

    const response = await drive.files.get({
      fileId: docId,
      fields: "name",
    });

    return response.data.name ?? null;
  } catch (error) {
    log.error("[google/drive] Failed to get doc name", {
      docId,
      error: parseError(error),
    });
    return null;
  }
}

/**
 * Get user information from Google OAuth.
 * Returns the user's email and optionally name/picture.
 */
export async function getUserInfo(
  accessToken: string
): Promise<GoogleUserInfo> {
  try {
    const response = await fetch(GOOGLE_USERINFO_URL, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
    });

    if (!response.ok) {
      const errorText = await response.text();
      log.error("[google/userinfo] Failed to get user info", {
        status: response.status,
        error: redactTokensFromError(errorText),
      });
      throw new Error(`Failed to get user info: ${response.status}`);
    }

    const data = await response.json();
    return {
      email: data.email,
      name: data.name,
      picture: data.picture,
    };
  } catch (error) {
    log.error("[google/userinfo] Get user info error", {
      error: parseError(error),
    });
    throw error;
  }
}

/**
 * Check if Google integration is configured.
 * Returns true only if both CLIENT_ID and CLIENT_SECRET are set.
 */
export function isGoogleConfigured(): boolean {
  try {
    getRequiredCredentials();
    return true;
  } catch {
    return false;
  }
}
