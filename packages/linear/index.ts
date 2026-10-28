import "server-only";
import { LinearClient } from "@linear/sdk";
import { redactSecrets } from "@repo/lib/security/redact-secrets";
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
  TASK_EXTRACTION_TIMEOUT_MS,
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

// =============================================================================
// OAuth Functions
// =============================================================================

const LINEAR_TOKEN_URL = "https://api.linear.app/oauth/token";
const LINEAR_REVOKE_URL = "https://api.linear.app/oauth/revoke";

const CREDENTIAL_MARKER = "[REDACTED]";

/**
 * Credential-keyed values as they appear in an OAuth request body, query string,
 * or JSON error echo — `client_secret=…`, `"refresh_token": "…"`.
 *
 * Matching the KEY, rather than the shape of the value, is the whole point: a
 * bare run of token-alphabet characters is indistinguishable from a request id,
 * a hostname segment, or an error-code name, so a length-only rule deletes the
 * diagnostics an operator needs AND emits a `[REDACTED]` marker claiming a
 * secret was found when none was. Module-level so Ultracite's `useTopLevelRegex`
 * holds and the `g` flag is compiled once.
 */
const CREDENTIAL_KEY_VALUE_PATTERN =
  /\b(client_secret|access_token|refresh_token|code_verifier)(["']?\s*[=:]\s*["']?)([^"'&\s,}]+)/gi;

/**
 * The authorization `code` in a form-encoded body or query string. Deliberately
 * restricted to the exact `code=value` form — no colon, no surrounding
 * whitespace — so "status code: 400" and `"error_code": "invalid_grant"` keep
 * their values. `code_verifier=` cannot match it (the character after `code` is
 * `_`, not `=`); that key is handled above.
 */
const AUTHORIZATION_CODE_PARAM_PATTERN = /\bcode=([^"'&\s,}]+)/gi;

/**
 * A known credential shorter than this is left alone. `String.replaceAll("")`
 * splices the marker between every character, and a short placeholder value (an
 * unset `client_secret`, a stubbed verifier) would carpet the message with
 * markers instead of redacting anything real.
 */
const MIN_KNOWN_CREDENTIAL_CHARS = 8;

/**
 * Redact credential material from error text before it is logged or rethrown.
 *
 * Three RECOGNIZED forms, never a length or entropy heuristic: the shared
 * provider-shape set (`@repo/lib/security/redact-secrets`, the same SSOT the
 * rest of the repo redacts with), credential-KEYED `key=value` / `"key":"value"`
 * pairs, and the exact credential values the calling operation was handed. A
 * marker is therefore emitted only when one of those actually matched, so an
 * ordinary 20+ character request id or error code survives intact and a clean
 * message stays marker-free.
 *
 * BOUNDARY: this protects the log sinks in this module AND the sanitized error
 * these operations rethrow (see `sanitizedOAuthError`) — the raw error object is
 * never propagated, so a caller's own `parseError(error)` cannot re-leak it. It
 * is still NOT whole-flow redaction: a transport-layer log emitted outside this
 * package (an HTTP client's own request logging) is unprotected. Do not read a
 * `[REDACTED]`-clean summary from here as proof the raw body was never recorded
 * anywhere else.
 */
function redactTokensFromError(
  errorText: string,
  knownCredentials: readonly (string | undefined)[] = []
): string {
  let out = redactSecrets(errorText);
  // The pattern is stateful (`g`) — reset before reuse across calls.
  CREDENTIAL_KEY_VALUE_PATTERN.lastIndex = 0;
  out = out.replace(
    CREDENTIAL_KEY_VALUE_PATTERN,
    (_match, key: string, separator: string) =>
      `${key}${separator}${CREDENTIAL_MARKER}`
  );
  AUTHORIZATION_CODE_PARAM_PATTERN.lastIndex = 0;
  out = out.replace(
    AUTHORIZATION_CODE_PARAM_PATTERN,
    `code=${CREDENTIAL_MARKER}`
  );
  for (const credential of knownCredentials) {
    if (credential && credential.length >= MIN_KNOWN_CREDENTIAL_CHARS) {
      out = out.replaceAll(credential, CREDENTIAL_MARKER);
    }
  }
  return out;
}

/**
 * The error an OAuth operation rethrows after logging.
 *
 * Sanitizing the log line alone was not redaction: `throw error` handed the
 * ORIGINAL secret-bearing error to the service layer, and both production
 * callers (`apps/api/app/integrations/linear/service.ts`) log `parseError(error)`
 * again in their own catch — so exchange and refresh transport failures leaked
 * the credentials one frame up. This returns a replacement carrying only the
 * redacted text, with NO `cause`: attaching the original would re-expose the raw
 * message to every upstream sink and reopen exactly that leak.
 */
function sanitizedOAuthError(
  error: unknown,
  knownCredentials: readonly (string | undefined)[]
): Error {
  return new Error(redactTokensFromError(parseError(error), knownCredentials));
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
 * Exchange an authorization code for tokens.
 * Called by the API after the app receives the OAuth callback.
 */
export async function exchangeCodeForTokens(
  code: string,
  codeVerifier: string,
  redirectUri: string
): Promise<LinearTokens> {
  const { clientId, clientSecret } = getRequiredCredentials();
  // Every credential this operation holds, so they are redacted by exact value
  // wherever a failure echoes them — no length heuristic required.
  const exchangeCredentials = [clientSecret, code, codeVerifier] as const;

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
        error: redactTokensFromError(errorText, exchangeCredentials),
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
    // ISS-6078: the request body carries `client_secret`, the auth code, and the
    // verifier, and this sink sits OUTSIDE the non-OK branch that already
    // redacts — a transport or parse failure that echoes any of it would reach
    // the log in clear. Redact here too.
    const sanitized = sanitizedOAuthError(error, exchangeCredentials);
    log.error("[linear/oauth] Token exchange error", {
      error: sanitized.message,
    });
    // ISS-6709: rethrow the SANITIZED error, not the original — the service
    // layer logs `parseError(error)` again in its own catch.
    throw sanitized;
  }
}

/**
 * Refresh an access token using a refresh token.
 */
export async function refreshAccessToken(
  refreshToken: string
): Promise<LinearTokens> {
  const { clientId, clientSecret } = getRequiredCredentials();
  const refreshCredentials = [clientSecret, refreshToken] as const;

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
        error: redactTokensFromError(errorText, refreshCredentials),
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
    // Log and re-throw to preserve error handling upstream. ISS-6078: redacted
    // for the same reason as the exchange outer catch — the request body carries
    // `client_secret` and the refresh token. ISS-6709: the REPLACEMENT is what
    // travels upstream, so the service layer's own `parseError(error)` cannot
    // re-leak the original.
    const sanitized = sanitizedOAuthError(error, refreshCredentials);
    log.error("[linear/oauth] Token refresh error", {
      error: sanitized.message,
    });
    throw sanitized;
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
      // ISS-6078: the revoke body is the access token itself, so this branch
      // needs the same redaction the exchange/refresh non-OK branches already
      // had — it was the one token call site logging a response body raw.
      log.warn("[linear/oauth] Token revocation failed (continuing anyway)", {
        status: response.status,
        error: redactTokensFromError(errorText, [accessToken]),
      });
    }
  } catch (error) {
    // Best effort - log but don't throw, so there is no rethrown error to
    // sanitize here; the log sink is the only sink.
    log.warn("[linear/oauth] Token revocation error (continuing anyway)", {
      error: redactTokensFromError(parseError(error), [accessToken]),
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
