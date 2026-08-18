import { unwrapApiResultData } from "../util/api-response-utils.js";
import type { DesktopPopSigner } from "./desktop-pop.js";

/**
 * Desktop-side client for the PR-K (PRD-532 §5.5, M8) session-authenticated
 * DESKTOP_MANAGED key provisioning endpoint (`POST /desktop/managed-key/provision`).
 *
 * Unlike the onboarding-attempt bootstrap claim, this runs after the unified
 * auth loopback sign-in: the caller already holds a first-party desktop session
 * access token. The request therefore carries BOTH the session Bearer token
 * (so `withDesktopSessionAuth` resolves org/user) AND a fresh Ed25519 device PoP
 * signature over the request (so the server can prove the caller still holds the
 * device key bound to their session before minting). The returned `sk_live_*`
 * key is stored main-process-only by the caller and never crosses to any
 * renderer. This module never logs token, key, or signature material.
 */

const PROVISION_PATH = "/desktop/managed-key/provision";
const REQUEST_TIMEOUT_MS = 10_000;

export type ProvisionManagedKeyOptions = {
  apiOrigin: string;
  gatewayId: string;
  /** PEM-encoded Ed25519 SPKI public key the managed key must bind to. */
  gatewayPublicKeyPem: string;
  /** First-party desktop session access token (Bearer), memory-only. */
  accessToken: string;
  /** Signs the request with the bound Ed25519 device key. */
  popSigner: DesktopPopSigner;
  fetchImpl?: typeof fetch;
};

export type ProvisionManagedKeyResult =
  | { kind: "provisioned"; apiKey: string }
  | { kind: "pop_unavailable" }
  | { kind: "failed"; statusCode?: number; retryable: boolean; error: string };

/**
 * Provision (or idempotently rotate) the DESKTOP_MANAGED relay key for this
 * device. Returns `pop_unavailable` before any network call when the local PoP
 * signer cannot produce headers, so the caller can fall back to today's paste
 * path (flag OFF) or surface a manual-setup prompt.
 */
export async function provisionManagedKey(
  options: ProvisionManagedKeyOptions
): Promise<ProvisionManagedKeyResult> {
  const gatewayPublicKeyPem = options.gatewayPublicKeyPem.trim();
  const gatewayId = options.gatewayId.trim();
  const accessToken = options.accessToken.trim();
  if (!(gatewayPublicKeyPem && gatewayId && accessToken)) {
    return {
      kind: "failed",
      retryable: false,
      error:
        "managed key provisioning requires gatewayId, gatewayPublicKeyPem, and a session access token",
    };
  }

  let url: URL;
  try {
    url = new URL(PROVISION_PATH, options.apiOrigin);
  } catch {
    return { kind: "failed", retryable: false, error: "invalid apiOrigin" };
  }

  let popHeaders: Awaited<ReturnType<DesktopPopSigner>>;
  try {
    popHeaders = await options.popSigner({
      method: "POST",
      pathname: url.pathname,
    });
  } catch {
    popHeaders = null;
  }
  if (!popHeaders) {
    return { kind: "pop_unavailable" };
  }

  const fetchFn = options.fetchImpl ?? fetch;
  let response: Response;
  try {
    response = await fetchFn(url.toString(), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${accessToken}`,
        ...popHeaders,
      },
      body: JSON.stringify({ gatewayId, gatewayPublicKeyPem }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch {
    return {
      kind: "failed",
      statusCode: 502,
      retryable: true,
      error: "managed key provisioning request failed",
    };
  }

  let body: unknown = null;
  try {
    body = await response.json();
  } catch {
    body = null;
  }

  if (!response.ok) {
    return {
      kind: "failed",
      statusCode: response.status,
      // 409 (concurrent rotation) and 5xx are transient; a 401/403 means the
      // session/PoP itself was rejected and retrying the same inputs will not help.
      retryable:
        response.status === 409 ||
        response.status === 502 ||
        response.status === 503,
      error:
        extractErrorMessage(body) ??
        `managed key provisioning failed (${response.status})`,
    };
  }

  const apiKey = extractApiKey(body);
  if (!apiKey) {
    return {
      kind: "failed",
      statusCode: response.status,
      retryable: false,
      error: "managed key provisioning response missing apiKey",
    };
  }
  return { kind: "provisioned", apiKey };
}

function extractApiKey(body: unknown): string | null {
  const payload = unwrapApiResultData(body);
  const value = payload.apiKey;
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function extractErrorMessage(body: unknown): string | null {
  if (typeof body === "object" && body !== null && "error" in body) {
    const value = (body as { error: unknown }).error;
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }
  return null;
}
