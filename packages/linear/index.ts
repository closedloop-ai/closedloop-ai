import "server-only";
import { LinearClient } from "@linear/sdk";
import { parseError } from "@repo/observability/error";
import { log } from "@repo/observability/log";
import { z } from "zod";
import { keys } from "./keys";

// Re-export task extraction and formatting
// biome-ignore lint/performance/noBarrelFile: package public API
export {
  type ExtractedTask,
  extractTasksWithLLM,
  formatTaskForLinear,
} from "./task-extractor";

// Lazy config getter - only validates when actually called at runtime
let _config: ReturnType<typeof keys> | null = null;
function getConfig() {
  if (!_config) {
    _config = keys();
  }
  return _config;
}

/**
 * Get required Linear credentials, throwing if not configured.
 * Use this in functions that require Linear to be configured.
 */
function getRequiredCredentials(): {
  clientId: string;
  clientSecret: string;
} {
  const config = getConfig();
  if (!(config.LINEAR_CLIENT_ID && config.LINEAR_CLIENT_SECRET)) {
    throw new Error(
      "Linear integration not configured. Set LINEAR_CLIENT_ID and LINEAR_CLIENT_SECRET."
    );
  }
  return {
    clientId: config.LINEAR_CLIENT_ID,
    clientSecret: config.LINEAR_CLIENT_SECRET,
  };
}

// =============================================================================
// Types
// =============================================================================

export type LinearTokens = {
  accessToken: string;
  refreshToken?: string;
  expiresIn?: number;
  tokenType: string;
  scope: string[];
};

/**
 * Linear team type representing the external Linear API response.
 *
 * Note: This type is also defined in @repo/api/src/types/linear.ts.
 * The duplication is intentional for proper architectural layering:
 * - This type represents what the Linear SDK returns (external API contract)
 * - @repo/api type represents what our API exposes (internal API contract)
 * - Keeps low-level packages independent of high-level API contracts
 * - Allows types to evolve independently if needed
 */
export type LinearTeam = {
  id: string;
  name: string;
  key: string;
};

export type LinearOrg = {
  id: string;
  name: string;
};

export type CreateIssueInput = {
  teamId: string;
  title: string;
  description?: string;
  priority?: number;
};

export type CreatedIssue = {
  id: string;
  identifier: string;
  url: string;
  title: string;
};

export type PKCEChallenge = {
  codeVerifier: string;
  codeChallenge: string;
  codeChallengeMethod: "S256";
};

// =============================================================================
// OAuth Functions
// =============================================================================

const LINEAR_TOKEN_URL = "https://api.linear.app/oauth/token";
const LINEAR_REVOKE_URL = "https://api.linear.app/oauth/revoke";

/**
 * Redact potential tokens from error messages.
 * Matches strings that look like tokens (20+ alphanumeric chars with dashes/underscores).
 */
function redactTokensFromError(errorText: string): string {
  return errorText.replace(/[a-zA-Z0-9_-]{20,}/g, "[REDACTED]");
}

/**
 * Zod schema for validating Linear OAuth token responses.
 * Ensures the response from Linear's token endpoint matches expected structure.
 */
const linearTokenResponseSchema = z.object({
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
): Promise<LinearTokens> {
  const { clientId, clientSecret } = getRequiredCredentials();

  try {
    const response = await fetch(LINEAR_TOKEN_URL, {
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
      log.error("[linear/oauth] Token exchange failed", {
        status: response.status,
        error: redactTokensFromError(errorText),
      });
      throw new Error(`Token exchange failed: ${response.status}`);
    }

    const json = await response.json();
    const data = linearTokenResponseSchema.parse(json);

    return {
      accessToken: data.access_token,
      refreshToken: data.refresh_token,
      expiresIn: data.expires_in,
      tokenType: data.token_type,
      scope: data.scope?.split(",") ?? [],
    };
  } catch (error) {
    log.error("[linear/oauth] Token exchange error", {
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
): Promise<LinearTokens> {
  const { clientId, clientSecret } = getRequiredCredentials();

  try {
    const response = await fetch(LINEAR_TOKEN_URL, {
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
      log.error("[linear/oauth] Token refresh failed", {
        status: response.status,
        error: redactTokensFromError(errorText),
      });
      throw new Error(`Token refresh failed: ${response.status}`);
    }

    const json = await response.json();
    const data = linearTokenResponseSchema.parse(json);

    return {
      accessToken: data.access_token,
      refreshToken: data.refresh_token,
      expiresIn: data.expires_in,
      tokenType: data.token_type,
      scope: data.scope?.split(",") ?? [],
    };
  } catch (error) {
    // Log and re-throw to preserve error handling upstream
    log.error("[linear/oauth] Token refresh error", {
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
    const response = await fetch(LINEAR_REVOKE_URL, {
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
      log.warn("[linear/oauth] Token revocation failed (continuing anyway)", {
        status: response.status,
        error: errorText,
      });
    }
  } catch (error) {
    // Best effort - log but don't throw
    log.warn("[linear/oauth] Token revocation error (continuing anyway)", {
      error: parseError(error),
    });
  }
}

// =============================================================================
// API Client
// =============================================================================

/**
 * Create an authenticated Linear client.
 */
export function createLinearClient(accessToken: string): LinearClient {
  return new LinearClient({ accessToken });
}

// =============================================================================
// API Operations
// =============================================================================

/**
 * Get the authenticated user's organization info.
 */
export async function getViewer(
  client: LinearClient
): Promise<LinearOrg | null> {
  try {
    const viewer = await client.viewer;
    const org = await viewer.organization;
    return {
      id: org.id,
      name: org.name,
    };
  } catch (error) {
    log.error("[linear/api] Failed to get viewer", {
      error: parseError(error),
    });
    return null;
  }
}

/**
 * Get all teams in the authenticated user's organization.
 */
export async function getTeams(client: LinearClient): Promise<LinearTeam[]> {
  try {
    const teams = await client.teams();
    return teams.nodes.map((team) => ({
      id: team.id,
      name: team.name,
      key: team.key,
    }));
  } catch (error) {
    log.error("[linear/api] Failed to get teams", {
      error: parseError(error),
    });
    return [];
  }
}

/**
 * Create a single issue in Linear.
 */
export async function createIssue(
  client: LinearClient,
  input: CreateIssueInput
): Promise<CreatedIssue> {
  try {
    const payload = await client.createIssue({
      teamId: input.teamId,
      title: input.title,
      description: input.description,
      priority: input.priority,
    });

    const issue = await payload.issue;

    if (!issue) {
      throw new Error("Failed to create issue");
    }

    return {
      id: issue.id,
      identifier: issue.identifier,
      url: issue.url,
      title: issue.title,
    };
  } catch (error) {
    log.error("[linear/api] Create issue error", {
      title: input.title,
      error: parseError(error),
    });
    throw error;
  }
}

/**
 * Create multiple issues in Linear.
 * Issues are created sequentially to respect rate limits.
 */
export async function createIssues(
  client: LinearClient,
  inputs: CreateIssueInput[]
): Promise<CreatedIssue[]> {
  const results: CreatedIssue[] = [];

  for (const input of inputs) {
    try {
      const issue = await createIssue(client, input);
      results.push(issue);
      log.info("[linear/api] Created issue", {
        identifier: issue.identifier,
        title: issue.title,
      });
    } catch (error) {
      log.error("[linear/api] Failed to create issue", {
        title: input.title,
        error: parseError(error),
      });
      throw error;
    }
  }

  return results;
}
