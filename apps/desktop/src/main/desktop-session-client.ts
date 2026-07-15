import { asRecord, stringField } from "./api-response-utils.js";
import type { DesktopPopSigner } from "./desktop-pop.js";

/**
 * HTTP client for the first-party desktop session endpoints (FEA-1514 /
 * FEA-2219), the desktop counterpart of `apps/api/app/desktop/session/*`.
 *
 * Exchange, refresh, and revoke each require an Ed25519 device
 * proof-of-possession signature (`DesktopPopSigner`, reused from
 * {@link ./desktop-pop}) so a stolen refresh token alone cannot mint or rotate
 * credentials. These functions never log token, refresh, or signature material;
 * callers receive a typed result and the manager keeps secrets in memory / the
 * encrypted store only.
 */

const REFRESH_PATH = "/desktop/session/refresh";
const REVOKE_PATH = "/desktop/session/revoke";

// Request timeout for the PoP-signed session POSTs. Without it, a
// TCP-accepted-but-never-answering `/desktop/session/refresh` leaves the fetch
// pending forever; `DesktopSessionManager.refreshNow()` stores this promise in
// `refreshInFlight` and clears it only in `.finally`, so every later
// `getAccessToken()` would return the same stuck single-flight promise. Matches
// `desktop-identity-client.ts`.
const REQUEST_TIMEOUT_MS = 10_000;

/** Credentials returned by refresh / authorize-token redeem. Access token is memory-only. */
export type DesktopSessionTokens = {
  accessToken: string;
  accessTokenExpiresAt: string;
  refreshToken: string;
  refreshTokenExpiresAt: string;
  userId: string;
  organizationId: string;
};

export type DesktopSessionRequestError =
  /** The local PoP signer could not produce headers (key/safeStorage issue). */
  | "pop_unavailable"
  /** Server rejected the PoP signature (403). */
  | "pop_rejected"
  /** Approved device session was already exchanged/consumed (409). */
  | "already_used"
  /** Approved device session has no resolved org yet (400 ORG_REQUIRED). */
  | "org_required"
  /** Auth-level rejection — invalid/expired/forged (401). */
  | "invalid"
  /** Malformed request body (400). */
  | "bad_request"
  /** Server-side transient failure (503). */
  | "unavailable"
  /** Network/transport failure before a response. */
  | "network";

export type DesktopSessionResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: DesktopSessionRequestError; retryable: boolean };

export type RefreshDesktopSessionInput = {
  apiOrigin: string;
  refreshToken: string;
  popSigner: DesktopPopSigner;
  fetchImpl?: typeof fetch;
};

// Revoke takes the same shape as refresh: a refresh token operated on under PoP.
export type RevokeDesktopSessionInput = RefreshDesktopSessionInput;

/** Rotate the refresh token, returning fresh session tokens. */
export function refreshDesktopSession(
  input: RefreshDesktopSessionInput
): Promise<DesktopSessionResult<DesktopSessionTokens>> {
  return postSignedDesktopSession({
    apiOrigin: input.apiOrigin,
    path: REFRESH_PATH,
    body: { refreshToken: input.refreshToken },
    popSigner: input.popSigner,
    fetchImpl: input.fetchImpl,
    parse: parseSessionTokens,
  });
}

/** Revoke the desktop session and its whole refresh-token family (sign-out). */
export function revokeDesktopSession(
  input: RevokeDesktopSessionInput
): Promise<DesktopSessionResult<true>> {
  return postSignedDesktopSession({
    apiOrigin: input.apiOrigin,
    path: REVOKE_PATH,
    body: { refreshToken: input.refreshToken },
    popSigner: input.popSigner,
    fetchImpl: input.fetchImpl,
    parse: () => true,
  });
}

type PostSignedDesktopSessionInput<T> = {
  apiOrigin: string;
  path: string;
  body: Record<string, unknown>;
  popSigner: DesktopPopSigner;
  fetchImpl?: typeof fetch;
  parse: (body: unknown) => T | null;
};

/**
 * PoP-signed POST shared by the `/desktop/session/*` endpoints here and the
 * `/desktop/authorize/token` redeem in {@link ./desktop-authorize-client}: the
 * transport (PoP signing, fetch, status→error mapping) is identical, so the
 * authorize client reuses this instead of reimplementing it.
 */
export async function postSignedDesktopSession<T>(
  input: PostSignedDesktopSessionInput<T>
): Promise<DesktopSessionResult<T>> {
  let url: URL;
  try {
    url = new URL(input.path, input.apiOrigin);
  } catch {
    return { ok: false, error: "network", retryable: false };
  }

  let popHeaders: Awaited<ReturnType<DesktopPopSigner>>;
  try {
    popHeaders = await input.popSigner({
      method: "POST",
      pathname: url.pathname,
    });
  } catch {
    popHeaders = null;
  }
  if (!popHeaders) {
    return { ok: false, error: "pop_unavailable", retryable: false };
  }

  const fetchFn = input.fetchImpl ?? fetch;
  let response: Response;
  try {
    response = await fetchFn(url.toString(), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...popHeaders,
      },
      body: JSON.stringify(input.body),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch {
    return { ok: false, error: "network", retryable: true };
  }

  let parsedBody: unknown = null;
  try {
    parsedBody = await response.json();
  } catch {
    parsedBody = null;
  }

  if (!response.ok) {
    return { ok: false, ...mapErrorResponse(response.status, parsedBody) };
  }

  const value = input.parse(parsedBody);
  if (value === null) {
    return { ok: false, error: "invalid", retryable: false };
  }
  return { ok: true, value };
}

function mapErrorResponse(
  status: number,
  body: unknown
): { error: DesktopSessionRequestError; retryable: boolean } {
  const record = asRecord(body);
  const contractRetryable =
    typeof record.retryable === "boolean" ? record.retryable : undefined;

  switch (status) {
    case 403:
      return { error: "pop_rejected", retryable: contractRetryable ?? false };
    case 409:
      return { error: "already_used", retryable: contractRetryable ?? false };
    case 400:
      return mapBadRequest(record, contractRetryable);
    case 401:
      return { error: "invalid", retryable: contractRetryable ?? false };
    // 408 Request Timeout / 429 Too Many Requests are transient and can be
    // injected by edge infra (rate limiter, CDN/WAF) even though the desktop
    // routes themselves never emit them. Treat as retryable so a startup
    // refresh does not permanently discard a still-valid stored session.
    case 408:
    case 429:
    case 503:
      return { error: "unavailable", retryable: contractRetryable ?? true };
    default:
      // An unrecognized status is NOT an auth-level invalidation — only an
      // explicit 401 means the credential/code itself is invalid. Treat an
      // unexpected status as a service failure (retryable for 5xx) so the
      // authorize-code redeem never mis-reports a transient server/edge error
      // as an expired code; it routes through the exchange_failed path instead.
      return {
        error: "unavailable",
        retryable: contractRetryable ?? status >= 500,
      };
  }
}

function mapBadRequest(
  record: Record<string, unknown>,
  contractRetryable: boolean | undefined
): { error: DesktopSessionRequestError; retryable: boolean } {
  if (record.code === "DESKTOP_SESSION_ORG_REQUIRED") {
    return { error: "org_required", retryable: contractRetryable ?? false };
  }
  return { error: "bad_request", retryable: contractRetryable ?? false };
}

/** Parse a `DesktopSessionTokens` body; shared with the authorize-token redeem. */
export function parseSessionTokens(body: unknown): DesktopSessionTokens | null {
  const record = asRecord(body);
  const tokens: DesktopSessionTokens = {
    accessToken: stringField(record.accessToken),
    accessTokenExpiresAt: stringField(record.accessTokenExpiresAt),
    refreshToken: stringField(record.refreshToken),
    refreshTokenExpiresAt: stringField(record.refreshTokenExpiresAt),
    userId: stringField(record.userId),
    organizationId: stringField(record.organizationId),
  };
  const complete = Object.values(tokens).every((value) => value.length > 0);
  return complete ? tokens : null;
}
