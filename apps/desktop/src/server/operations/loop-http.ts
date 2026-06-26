import crypto from "node:crypto";
import { buildManagedDesktopPopHeaders } from "../../main/desktop-pop-sign-utils.js";
import { gatewayLog } from "../../main/gateway-logger.js";
import type { LoopPopDeps } from "../../main/loop-lifecycle.js";
import type {
  LoopTokenMeta,
  LoopTokenStore,
} from "../../main/loop-token-store.js";
import { loopError, loopLog } from "./symphony-utils.js";

// ---------------------------------------------------------------------------
// Consolidated HTTP helpers for loop event posting and artifact upload.
//
// All three functions accept `getToken: () => string | null` so that
// long-lived closures (output tailer, boot-recovery) resolve the current
// token on every request rather than capturing a stale string at
// construction time.
//
// Return shape is a discriminated union on `kind` so callers (notably the
// output tailer's retry classifier) can branch on a typed field rather than
// parsing substrings out of the human-readable `error` string.
// ---------------------------------------------------------------------------

export type HeartbeatRevivalFields = {
  revived: boolean;
  token?: string;
  expiresAt?: Date;
  jti?: string;
};

export type LoopHttpResult =
  | ({ success: true; status: number } & Partial<HeartbeatRevivalFields>)
  | { success: false; kind: "http"; status: number; error: string }
  | { success: false; kind: "network"; error: string }
  | { success: false; kind: "timeout"; error: "timeout" }
  | { success: false; kind: "auth"; error: "missing_token" };

/**
 * Persists a freshly-minted runner token when a heartbeat response reports the
 * loop was revived. Single source of truth for the revival-token write, shared
 * by the live heartbeat path (loop-heartbeat.ts) and the boot-recovery PoP
 * revival path (boot-recovery.ts) so the `expiresAt.getTime()` mapping and the
 * revived/token guard cannot drift between them.
 *
 * @returns `true` when a revival token was adopted; `false` when the result is
 *   not a revival (so callers can branch their own logging).
 */
export function persistRevivalToken(
  loopTokenStore: Pick<LoopTokenStore, "setLoopToken"> | undefined,
  loopId: string,
  result: LoopHttpResult
): boolean {
  if (loopTokenStore === undefined || !result.success) {
    return false;
  }
  if (result.revived !== true || result.token === undefined) {
    return false;
  }
  loopTokenStore.setLoopToken(loopId, {
    token: result.token,
    jti: result.jti,
    expiresAt:
      result.expiresAt === undefined ? undefined : result.expiresAt.getTime(),
  });
  return true;
}

/**
 * POST a single loop event to the cloud API.
 *
 * Auto-injects a `timestamp` field when not already present in `eventBody`
 * (matches ECS harness `reportEvent()` behaviour).
 * Generates a fresh `x-loop-event-nonce` UUID on every call.
 *
 * Short-circuits with `kind: "auth"` when `getToken()` returns null so the
 * caller can skip the round trip and the inevitable 401.
 */
export async function postLoopEvent(
  apiBaseUrl: string,
  loopId: string,
  getToken: () => string | null,
  eventBody: Record<string, unknown>,
  signal?: AbortSignal
): Promise<LoopHttpResult> {
  const url = `${apiBaseUrl}/loops/${encodeURIComponent(loopId)}/events`;
  // Auto-inject timestamp on every event (matches ECS harness reportEvent())
  const payload: Record<string, unknown> = {
    ...eventBody,
    timestamp: eventBody.timestamp ?? new Date().toISOString(),
  };
  loopLog(loopId, `POST event: ${payload.type}`, url);
  const token = getToken();
  if (token === null) {
    loopError(loopId, "No loop token available for event POST", url);
    gatewayLog.warn(
      "loop-event",
      `POST loopEvent type=${payload.type} loopId=${loopId} skipped: missing token`
    );
    return { success: false, kind: "auth", error: "missing_token" };
  }
  try {
    const resp = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        "x-loop-event-nonce": crypto.randomUUID(),
      },
      body: JSON.stringify(payload),
      signal,
    });
    if (!resp.ok) {
      const text = await resp.text().catch(() => "");
      loopError(
        loopId,
        `Event POST failed: ${resp.status} ${resp.statusText}`,
        text
      );
      gatewayLog.error(
        "loop-event",
        `POST loopEvent type=${payload.type} loopId=${loopId} url=${url} failed: ${resp.status} ${resp.statusText} ${text}`
      );
      return {
        success: false,
        kind: "http",
        status: resp.status,
        error: `HTTP ${resp.status} ${resp.statusText}`,
      };
    }
    loopLog(loopId, `Event POST success: ${resp.status}`);
    gatewayLog.info(
      "loop-event",
      `POST loopEvent type=${payload.type} loopId=${loopId} status=${resp.status}`
    );
    return { success: true, status: resp.status };
  } catch (err) {
    if (signal?.aborted) {
      return { success: false, kind: "timeout", error: "timeout" };
    }
    const msg = err instanceof Error ? err.message : String(err);
    loopError(loopId, "Failed to post event:", err);
    gatewayLog.error(
      "loop-event",
      `POST loopEvent type=${payload.type} loopId=${loopId} network error: ${msg}`
    );
    return { success: false, kind: "network", error: msg };
  }
}

/**
 * POST a loop event with an AbortController-based timeout.
 *
 * Uses `postLoopEvent` internally; aborts the fetch if `timeoutMs` elapses
 * before a response is received.  Defaults to a 1 000 ms timeout.
 */
export async function postLoopEventBounded(
  apiBaseUrl: string,
  loopId: string,
  getToken: () => string | null,
  eventBody: Record<string, unknown>,
  timeoutMs = 1000
): Promise<LoopHttpResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await postLoopEvent(
      apiBaseUrl,
      loopId,
      getToken,
      eventBody,
      controller.signal
    );
  } finally {
    clearTimeout(timer);
  }
}

/**
 * POST artifact data to the cloud upload-artifacts endpoint.
 *
 * Unlike `postLoopEvent`, this call does NOT include `x-loop-event-nonce`
 * (artifact uploads are not idempotency-keyed events).
 *
 * Short-circuits with `kind: "auth"` when `getToken()` returns null.
 */
export async function uploadArtifacts(
  apiBaseUrl: string,
  loopId: string,
  getToken: () => string | null,
  body: Record<string, unknown>
): Promise<LoopHttpResult> {
  const url = `${apiBaseUrl}/loops/${encodeURIComponent(loopId)}/upload-artifacts`;
  loopLog(loopId, "Uploading artifacts...", url);
  const token = getToken();
  if (token === null) {
    loopError(loopId, "No loop token available for artifact upload", url);
    gatewayLog.warn(
      "loop-upload",
      `Artifact upload for loopId=${loopId} skipped: missing token`
    );
    return { success: false, kind: "auth", error: "missing_token" };
  }
  try {
    const resp = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });
    if (!resp.ok) {
      const text = await resp.text().catch(() => "");
      loopError(
        loopId,
        `Upload failed: ${resp.status} ${resp.statusText}`,
        text
      );
      gatewayLog.error(
        "loop-upload",
        `Artifact upload to ${url} failed: ${resp.status} ${resp.statusText} ${text}`
      );
      return {
        success: false,
        kind: "http",
        status: resp.status,
        error: `HTTP ${resp.status} ${resp.statusText}`,
      };
    }
    loopLog(loopId, `Upload success: ${resp.status}`);
    gatewayLog.info(
      "loop-upload",
      `Artifact upload for loopId=${loopId}: ${resp.status}`
    );
    return { success: true, status: resp.status };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    loopError(loopId, "Failed to upload artifacts:", err);
    gatewayLog.error("loop-upload", `Artifact upload network error: ${msg}`);
    return { success: false, kind: "network", error: msg };
  }
}

/**
 * GET the current status of a cloud loop.
 *
 * Returns `{ kind: 'active' }` for any running/non-terminal status,
 * `{ kind: 'timed_out' }` when the API reports status === 'TIMED_OUT',
 * `{ kind: 'unauthorized' }` on HTTP 401 (so callers can refresh and retry
 * via a typed branch rather than a string-equality check),
 * or `{ kind: 'error', message }` on other HTTP errors / network failures.
 *
 * Uses an AbortController timeout (default 5 000 ms) matching the
 * postLoopEventBounded pattern.
 */
export type CloudLoopStatus =
  | { kind: "timed_out" }
  | { kind: "active" }
  | { kind: "unauthorized" }
  | { kind: "error"; message: string; status?: number };

export async function getCloudLoopStatus(
  apiBaseUrl: string,
  loopId: string,
  getToken: () => string | null,
  timeoutMs = 5000
): Promise<CloudLoopStatus> {
  const url = `${apiBaseUrl}/loops/${encodeURIComponent(loopId)}`;
  const token = getToken();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const resp = await fetch(url, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${token ?? ""}`,
      },
      signal: controller.signal,
    });
    if (resp.status === 401) {
      return { kind: "unauthorized" };
    }
    if (!resp.ok) {
      return {
        kind: "error",
        message: `HTTP ${resp.status}`,
        status: resp.status,
      };
    }
    const raw = (await resp.json()) as Record<string, unknown>;
    const status = typeof raw?.status === "string" ? raw.status : null;
    if (status === null) {
      gatewayLog.warn(
        "loop-status",
        `Unexpected response shape for loopId=${loopId}: ${JSON.stringify(raw)}`
      );
      return { kind: "active" };
    }
    if (status === "TIMED_OUT") {
      return { kind: "timed_out" };
    }
    return { kind: "active" };
  } catch (err) {
    return {
      kind: "error",
      message: err instanceof Error ? err.message : String(err),
    };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Clock skew tolerance for JWT expiry detection (30 seconds in milliseconds).
 * When a JWT's expiresAt is within this window, we treat it as stale and
 * proactively swap to the managed API key to avoid a round-trip 410.
 */
export const CLOCK_SKEW_MS = 30_000;

/**
 * Determines whether a persisted runner JWT is still usable for a heartbeat.
 *
 * Returns false when:
 * - `meta === null` (safety guard — caller should short-circuit before this)
 * - `meta.expiresAt` is set and the token is within CLOCK_SKEW_MS of expiry
 *
 * Returns true when:
 * - `meta.expiresAt === undefined` — legacy tokens (written by older desktop
 *   versions that did not track expiresAt). Treated as usable to avoid
 *   breaking existing tokens.
 * - Token is well before expiry.
 *
 * exported-jwt-still-in-store: runner JWT lives in LoopTokenStore until
 * finalization; refresh failures do not delete it, so this helper is the
 * authoritative expiry check.
 *
 * Exported for unit testing.
 */
export function isJwtUsable(
  meta: LoopTokenMeta | null,
  nowMs: number,
  clockSkewMs: number
): boolean {
  if (meta === null) {
    return false;
  }
  // Legacy tokens (expiresAt === undefined) are treated as usable — they may
  // be expired if written by an older desktop version that did not track
  // expiresAt. Accepted to avoid breaking existing tokens.
  if (meta.expiresAt === undefined) {
    return true;
  }
  return meta.expiresAt > nowMs + clockSkewMs;
}

/**
 * Deps required by postLoopHeartbeat for PoP signing and managed-key fallback.
 * Extends LoopPopDeps with optional token-meta retrieval for expiry detection.
 */
export type HeartbeatPopDeps = LoopPopDeps & {
  /**
   * Returns the full LoopTokenMeta for expiry detection (T-1.4).
   * When absent, falls back to the legacy `getToken` path (no expiry check).
   */
  getTokenMeta?: () => LoopTokenMeta | null;
  /**
   * Legacy token getter — kept for backwards compatibility with sendHeartbeatNow
   * callers that predate getTokenMeta.
   */
  getToken?: () => string | null;
};

/**
 * POST a heartbeat to `/loops/:id/heartbeat`.
 *
 * Returns the same `LoopHttpResult` discriminated union as `postLoopEvent`
 * so callers can branch on `kind === "http" && status === 404` without
 * parsing strings.
 *
 * ## PoP header attachment (AC-002, AC-003)
 * When provenance is DESKTOP_MANAGED, three X-Desktop-* PoP headers are
 * unconditionally attached via buildManagedDesktopPopHeaders. For RUNNING
 * loops the server's primary JWT auth succeeds and these headers are ignored;
 * for TIMED_OUT loops the server falls back to PoP verification. This is
 * intentional — the client cannot know loop status before sending.
 *
 * ## Authorization header strategy (AC-009, AC-011)
 * Four-way ladder:
 * 1. JWT usable (present and not near expiry)  → Bearer <runnerJWT>
 * 2. JWT stale  AND no DESKTOP_MANAGED key     → Bearer <staleJWT> + warn
 *    (last resort for USER_CREATED keys — preserves behavior, avoids silent fail)
 * 3. JWT stale  AND DESKTOP_MANAGED key        → Bearer <sk_live_managedKey>
 *    (proactive revival swap — avoids 410 from a known-stale token)
 * 4. getTokenMeta returns null AND getApiKey returns null → short-circuit auth
 *
 * ## Security invariant
 * The Authorization header value MUST NEVER appear in any gatewayLog entry.
 * The current implementation does not log headers — preserve this invariant.
 *
 * On a successful revival response the returned success object includes
 * `revived: true` plus the replacement runner token fields.
 */
export async function postLoopHeartbeat(
  apiBaseUrl: string,
  loopId: string,
  popDeps: HeartbeatPopDeps
): Promise<LoopHttpResult> {
  const {
    getToken,
    getTokenMeta,
    getApiKey,
    getApiKeyProvenance,
    signDesktopRequest,
    onDesktopPopUnavailable,
  } = popDeps;

  // ------------------------------------------------------------------
  // Determine which Authorization credential to use (four-way ladder).
  // ------------------------------------------------------------------

  // Resolve token meta — either from the new getTokenMeta (expiry-aware) or
  // from the legacy getToken path (no expiry check).
  let tokenMeta: LoopTokenMeta | null;
  if (getTokenMeta !== undefined) {
    tokenMeta = getTokenMeta();
  } else if (getToken === undefined) {
    tokenMeta = null;
  } else {
    // Legacy path: construct a pseudo-meta with no expiresAt so isJwtUsable
    // treats it as always usable.
    const tok = getToken();
    tokenMeta = tok === null ? null : { token: tok, expiresAt: undefined };
  }

  const nowMs = Date.now();
  const provenance = getApiKeyProvenance?.() ?? "USER_CREATED";
  const managedKey =
    provenance === "DESKTOP_MANAGED" ? (getApiKey?.() ?? null) : null;

  let authorizationValue: string;
  const jwtUsable =
    tokenMeta !== null && isJwtUsable(tokenMeta, nowMs, CLOCK_SKEW_MS);

  if (jwtUsable && tokenMeta !== null) {
    // Ladder rung 1: JWT is valid and not near expiry — use it.
    authorizationValue = `Bearer ${tokenMeta.token}`;
  } else if (!jwtUsable && managedKey === null) {
    if (tokenMeta === null) {
      // Ladder rung 4: no token meta and no managed key — short-circuit.
      return { success: false, kind: "auth", error: "missing_token" };
    }
    // Ladder rung 2: JWT is stale but no managed key available — send
    // the stale JWT as a last resort (preserves behavior for USER_CREATED
    // keys; at least gives the server a chance to respond).
    // expired-JWT-still-in-store: runner JWT lives in LoopTokenStore until
    // finalization; refresh failures do not delete it, so getToken() alone
    // cannot detect a stale token.
    gatewayLog.warn(
      "loop-heartbeat",
      `Heartbeat for loopId=${loopId}: JWT is stale/expired and no DESKTOP_MANAGED key available; sending stale JWT as last resort`
    );
    authorizationValue = `Bearer ${tokenMeta.token}`;
  } else if (!jwtUsable && managedKey !== null) {
    // Ladder rung 3: JWT is stale but DESKTOP_MANAGED key is available —
    // proactive revival swap so the server can verify PoP and revive the loop.
    authorizationValue = `Bearer ${managedKey}`;
  } else {
    // Ladder rung 4: no usable token of any kind — short-circuit.
    return { success: false, kind: "auth", error: "missing_token" };
  }

  // ------------------------------------------------------------------
  // Attach PoP headers when provenance is DESKTOP_MANAGED (AC-002).
  // The PoP pathname is signed over the same encoded loop-id segment that is
  // sent on the wire (see encodedLoopId below), so the signed path and the
  // request path are byte-identical for any loopId — including ids that need
  // percent-encoding. Loop ids are UUIDs today (encode is a no-op), but signing
  // the encoded path removes the latent divergence the previous raw-path signing
  // would have introduced.
  // ------------------------------------------------------------------
  // PoP headers are attached unconditionally when provenance is DESKTOP_MANAGED.
  // For RUNNING loops the server primary JWT auth succeeds and these headers are
  // ignored; for TIMED_OUT loops the server falls back to PoP verification.
  // This is intentional — the client cannot know loop status before sending.
  //
  // Single source of truth for the loop-id path segment: used for both the PoP
  // signature pathname and the fetch URL so the two can never diverge.
  const encodedLoopId = encodeURIComponent(loopId);
  const popHeaders = await buildManagedDesktopPopHeaders({
    apiKeyProvenance: provenance,
    signDesktopRequest,
    request: {
      method: "POST",
      pathname: `/loops/${encodedLoopId}/heartbeat`,
    },
    surface: "loop-heartbeat",
    unavailableMessage:
      "PoP signing unavailable for heartbeat; revival disabled for this loop",
    onUnavailable: onDesktopPopUnavailable,
  });

  const url = `${apiBaseUrl}/loops/${encodedLoopId}/heartbeat`;

  const headers: Record<string, string> = {
    // Security invariant: NEVER log the Authorization header value in any
    // gatewayLog entry. The current implementation does not log headers — this
    // comment preserves that invariant explicitly.
    Authorization: authorizationValue,
    "Content-Type": "application/json",
    ...(popHeaders ?? {}),
  };

  try {
    const resp = await fetch(url, {
      method: "POST",
      headers,
    });
    if (!resp.ok) {
      return {
        success: false,
        kind: "http",
        status: resp.status,
        error: `HTTP ${resp.status} ${resp.statusText}`,
      };
    }

    const revivalFields = await parseHeartbeatRevivalFields(resp);
    return { success: true, status: resp.status, ...revivalFields };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { success: false, kind: "network", error: msg };
  }
}

/**
 * Attempts to parse revival fields from a successful heartbeat response body.
 *
 * Returns a `HeartbeatRevivalFields` partial when `revived` is true and the
 * body contains valid token fields; returns an empty object otherwise.
 * Never throws — a malformed body is treated as a non-revival response.
 */
async function parseHeartbeatRevivalFields(
  resp: Response
): Promise<Partial<HeartbeatRevivalFields>> {
  try {
    const raw = (await resp.json()) as Record<string, unknown>;
    // The API wraps the payload in { success, data }; unwrap if present.
    const data =
      raw.data !== undefined &&
      typeof raw.data === "object" &&
      raw.data !== null
        ? (raw.data as Record<string, unknown>)
        : raw;

    if (data.revived !== true) {
      return {};
    }
    const result: HeartbeatRevivalFields = { revived: true };
    if (typeof data.token === "string") {
      result.token = data.token;
    }
    if (typeof data.expiresAt === "string") {
      const parsed = new Date(data.expiresAt);
      if (!Number.isNaN(parsed.getTime())) {
        result.expiresAt = parsed;
      }
    }
    if (typeof data.jti === "string") {
      result.jti = data.jti;
    }
    return result;
  } catch {
    return {};
  }
}
