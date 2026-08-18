import type { ZodType } from "zod";
import { fetchJsonAndParse } from "./fetch-json-and-parse.js";

/**
 * Safely treats plain object values as JSON records.
 */
export function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/**
 * Returns a string field as-is, or `""` for any non-string value. Used by the
 * desktop response parsers to validate required string fields uniformly.
 */
export function stringField(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/**
 * Unwraps the common `{ success: true, data }` API envelope and returns the raw
 * `data` payload untouched (or the original body when it is not an envelope).
 *
 * Prefer this over {@link unwrapApiResultData} when `data` may be an array or
 * primitive: this preserves the true shape, whereas {@link unwrapApiResultData}
 * coerces any non-object (arrays included) to `{}`. Desktop API clients that
 * hand the result straight to a zod schema use this so the schema sees the
 * actual payload (e.g. a repository array).
 */
export function unwrapApiEnvelope(body: unknown): unknown {
  const record = asRecord(body);
  return record.success === true ? record.data : body;
}

/**
 * Unwraps the common `{ success: true, data: {...} }` API envelope, always
 * returning a record. Use {@link unwrapApiEnvelope} when `data` may be a
 * non-object (array/primitive) payload.
 */
export function unwrapApiResultData(body: unknown): Record<string, unknown> {
  const record = asRecord(body);
  if (
    record.success === true &&
    record.data &&
    typeof record.data === "object"
  ) {
    return asRecord(record.data);
  }
  return record;
}

/**
 * Extracts a redacted error message from either `error` or `error.message`.
 */
export function extractApiErrorMessage(body: unknown): string | null {
  const record = asRecord(body);
  if (typeof record.error === "string") {
    return record.error;
  }
  const errorRecord = asRecord(record.error);
  if (typeof errorRecord.message === "string") {
    return errorRecord.message;
  }
  return null;
}

/**
 * Shared session options for the Desktop main-process API clients that read
 * from the cloud on behalf of the signed-in first-party Desktop session.
 */
export type SessionFetchOptions = {
  fetch?: typeof fetch;
  getAccessToken: () => Promise<string | null>;
  getApiOrigin: () => string | undefined;
};

/**
 * Per-request overrides for {@link fetchSessionJson}. `headers` are merged in
 * addition to the always-applied `Bearer` `Authorization` header; `timeoutMs`
 * overrides the default abort timeout.
 */
export type SessionFetchRequestOptions = {
  headers?: Record<string, string>;
  timeoutMs?: number;
};

/** Default abort timeout for a Desktop session fetch, in milliseconds. */
const DEFAULT_SESSION_FETCH_TIMEOUT_MS = 10_000;

/**
 * Shared fetch-and-parse scaffold for Desktop main-process API clients that
 * read cloud data with the signed-in first-party Desktop session token. Reads
 * the session token, resolves the API origin, issues a `Bearer` fetch against
 * `path`, and validates the `{ success, data }`-unwrapped body against `schema`.
 *
 * Every transport, response, or schema failure returns null so callers can keep
 * a safe fallback instead of trusting a missing session or malformed data. The
 * caller-supplied `Authorization` header is never overridable — it is always
 * set from the session token.
 *
 * This is the session-token façade over the generic {@link fetchJsonAndParse}
 * scaffold: it resolves the token/origin from {@link SessionFetchOptions}, then
 * delegates the URL-build → Bearer GET → ok-guard → JSON → `unwrapApiEnvelope`
 * → `safeParse` pipeline (with a `null` sentinel) to that single helper so the
 * fetch-and-validate logic lives in exactly one place.
 */
export async function fetchSessionJson<T>(
  options: SessionFetchOptions,
  path: string,
  schema: ZodType<T>,
  requestOptions?: SessionFetchRequestOptions
): Promise<T | null> {
  let accessToken: string | null;
  try {
    accessToken = await options.getAccessToken();
  } catch {
    return null;
  }
  const apiOrigin = options.getApiOrigin();
  if (!(accessToken && apiOrigin)) {
    return null;
  }

  return fetchJsonAndParse(path, schema, {
    apiOrigin,
    token: accessToken,
    unwrap: unwrapApiEnvelope,
    sentinel: null,
    headers: requestOptions?.headers,
    timeoutMs: requestOptions?.timeoutMs ?? DEFAULT_SESSION_FETCH_TIMEOUT_MS,
    fetchImpl: options.fetch,
  });
}

/**
 * Extracts the machine-readable `code` from a failure `ApiResult` envelope, or
 * `null` when absent. The FEA-3425 desktop write-lane clients dispatch on
 * code + status, never status alone.
 */
export function extractApiErrorCode(body: unknown): string | null {
  const code = asRecord(body).code;
  return typeof code === "string" ? code : null;
}

/**
 * ISS-5090: extracts the additive `details.reason` diagnostic from a failure
 * `ApiResult` envelope, or `null` when absent. Sibling of
 * {@link extractApiErrorCode} so both "read one field off an API error body"
 * helpers stay in one place. Purely diagnostic: an older API omits `details`
 * entirely, and a non-string or empty value degrades to `null`, so a
 * version-skewed or proxy-mangled body can never break a caller.
 */
export function extractApiErrorDetailReason(body: unknown): string | null {
  const reason = asRecord(asRecord(body).details).reason;
  return typeof reason === "string" && reason.length > 0 ? reason : null;
}

/**
 * True when a fetch rejection came from `AbortSignal.timeout` (or an explicit
 * abort) rather than a connection-level failure. The write-lane clients treat
 * the two differently: a timed-out request may already have been processed
 * server-side, while a connection-level failure almost certainly was not.
 */
export function isAbortTimeoutError(error: unknown): boolean {
  return (
    error instanceof DOMException &&
    (error.name === "TimeoutError" || error.name === "AbortError")
  );
}

/**
 * Discriminated outcome of {@link postSessionJson}. `response` is any
 * server-answered HTTP response (2xx or not — the caller owns status/code
 * dispatch); the remaining kinds are the pre- and mid-flight failures a caller
 * must map onto its own fallback/retry policy.
 */
export type SessionPostOutcome =
  | { kind: "response"; response: Response }
  | { kind: "no_session" }
  | { kind: "no_origin" }
  | { kind: "timeout" }
  | { kind: "network_error"; error: unknown };

/**
 * Shared session-token POST scaffold for the FEA-3425 Phase-3 desktop
 * write-lane clients (the analytics HTTP lane and the telemetry HTTP client):
 * resolves the first-party session token and API origin from
 * {@link SessionFetchOptions}, issues a `Bearer`-authenticated JSON POST with an
 * abort timeout, and classifies every non-response failure. It deliberately
 * carries no retry loop and no response parsing — each lane owns its retry
 * policy and response contract. (The Phase-1 `desktop-agent-sessions-client`
 * predates this helper and still inlines its own POST; it shares only the
 * {@link extractApiErrorCode} / {@link isAbortTimeoutError} classifiers here.)
 */
export async function postSessionJson(
  options: SessionFetchOptions,
  path: string,
  body: unknown,
  requestOptions?: SessionFetchRequestOptions
): Promise<SessionPostOutcome> {
  let accessToken: string | null;
  try {
    accessToken = await options.getAccessToken();
  } catch {
    accessToken = null;
  }
  if (!accessToken) {
    return { kind: "no_session" };
  }

  const apiOrigin = options.getApiOrigin();
  let url: URL;
  try {
    url = new URL(path, apiOrigin);
  } catch {
    return { kind: "no_origin" };
  }

  try {
    const response = await (options.fetch ?? fetch)(url, {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        ...requestOptions?.headers,
        Authorization: `Bearer ${accessToken}`,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(
        requestOptions?.timeoutMs ?? DEFAULT_SESSION_FETCH_TIMEOUT_MS
      ),
    });
    return { kind: "response", response };
  } catch (error) {
    if (isAbortTimeoutError(error)) {
      return { kind: "timeout" };
    }
    return { kind: "network_error", error };
  }
}

/**
 * Shared pre-terminal dispatch for the FEA-3425 write-lane HTTP clients. Both
 * best-effort observability lanes classify a {@link SessionPostOutcome}
 * identically for everything that isn't a lane-specific terminal (2xx / coded
 * rejection). Since PLN-1437 Phase 4a there is no socket fallback — every
 * non-terminal outcome is a best-effort DROP, matching the retired socket
 * lane's silent drop on disconnect:
 * - `timeout` → `onTimeoutDrop()` (the server may have processed it, and these
 *   lanes carry no idempotency key, so a re-send would double-count)
 * - never reached the server (no session / no origin / network) → drop
 * - HTTP 401 → `onUnauthorized` + drop (early revocation/rotation)
 * - HTTP 404/405 → drop (the API deployment predates the route — version skew)
 *
 * Returns the server {@link Response} for the caller's lane-specific terminal
 * handling, or `null` when it fully handled (dropped) the outcome. Keeping this
 * in one place stops the two lanes' policy from drifting.
 */
export function resolveSessionPostOutcome(
  outcome: SessionPostOutcome,
  handlers: {
    onUnauthorized?: () => void;
    onTimeoutDrop: () => void;
  }
): Response | null {
  if (outcome.kind === "timeout") {
    handlers.onTimeoutDrop();
    return null;
  }
  if (outcome.kind !== "response") {
    // no_session / no_origin / network_error: never reached the server → drop.
    return null;
  }
  const { response } = outcome;
  if (response.status === 401) {
    handlers.onUnauthorized?.();
    return null;
  }
  if (response.status === 404 || response.status === 405) {
    return null;
  }
  return response;
}
