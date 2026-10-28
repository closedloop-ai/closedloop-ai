import type { ZodType } from "zod";
import { desktopClientAttributionHeaders } from "./desktop-client-attribution-provider.js";
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
  onUnauthorized?: (rejectedToken: string) => void;
};

/**
 * Per-request overrides for {@link fetchSessionJson}. `headers` are merged in
 * addition to the always-applied `Bearer` `Authorization` header; `timeoutMs`
 * overrides the default abort timeout.
 */
export type SessionFetchRequestOptions = {
  headers?: Record<string, string>;
  timeoutMs?: number;
  /** Re-read after credential resolution, immediately before a write leaves. */
  canStillSend?: () => boolean;
  /** Cancels a write already dispatched by an invalidated session. */
  signal?: AbortSignal;
};

export const SessionRequestCredentialKind = {
  AccessToken: "access_token",
  ApiKey: "api_key",
} as const;

export type SessionRequestCredentialKind =
  (typeof SessionRequestCredentialKind)[keyof typeof SessionRequestCredentialKind];

export type SessionClApiCredential = {
  token: string;
  credentialKind: SessionRequestCredentialKind;
};

export type SessionClApiRequestOptions = {
  apiOrigin: string;
  path: string;
  method?: string;
  query?: Record<string, string | null | undefined> | URLSearchParams;
  headers?: Record<string, string>;
  body?: RequestInit["body"];
  cache?: RequestInit["cache"];
  timeoutMs: number;
  signal?: AbortSignal;
  fetch?: typeof fetch;
  credential: SessionClApiCredential;
  onUnauthorized?: (rejectedToken: string) => void;
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
    // ISS-8749 attribution is merged by `fetchJsonAndParse` itself, so this
    // façade adds nothing here — the scaffold is the one place every
    // authenticated first-party read passes through.
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
  | { kind: "response"; response: Response; accessToken: string }
  | { kind: "no_session" }
  | { kind: "no_origin" }
  | { kind: "timeout" }
  | { kind: "network_error"; error: unknown };

/**
 * Shared session-token POST scaffold for the FEA-3425 Phase-3 desktop
 * write-lane clients (the analytics HTTP lane and the telemetry HTTP client):
 * resolves the first-party session token and API origin from
 * {@link SessionFetchOptions}, issues a `Bearer`-authenticated JSON POST through
 * {@link sendSessionClApiRequest}, and classifies every non-response failure. It
 * deliberately carries no retry loop and no response parsing — each lane owns
 * its retry policy and response contract.
 */
export function postSessionJson(
  options: SessionFetchOptions,
  path: string,
  body: unknown,
  requestOptions?: SessionFetchRequestOptions
): Promise<SessionPostOutcome> {
  return sendSessionJson(options, "POST", path, body, requestOptions);
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

/**
 * ISS-8599 (whitlockk review, PR #6762): the machine-readable `code` from a body
 * that IS a first-party failure envelope, or `null` for anything else.
 *
 * {@link extractApiErrorCode} reads `code` off whatever JSON it is handed, which
 * is fine where the value is only ever logged. It is NOT fine where the value is
 * an INSTRUCTION: a 403 does not have to come from our API at all — a proxy, WAF
 * or corporate gateway can answer one with its own JSON body — and such a body
 * is attacker- or infrastructure-controlled. Nothing in the type system
 * constrains what arrives over the wire, so the envelope has to be checked at
 * the boundary rather than assumed.
 *
 * `success: false` is the check because that is what `failure()` in
 * `@repo/api/src/types/common` emits on every first-party error path, coded or
 * not. A body missing it — a bare `{code}`, a `success: true` payload, a string,
 * an array — answers `null`, which every caller already treats as "the server
 * said nothing I can act on".
 */
export function extractApiFailureEnvelopeCode(body: unknown): string | null {
  return asRecord(body).success === false ? extractApiErrorCode(body) : null;
}

export async function sendSessionClApiRequest(
  options: SessionClApiRequestOptions
): Promise<Response> {
  const response = await (options.fetch ?? fetch)(
    buildSessionClApiUrl(options.apiOrigin, options.path, options.query),
    buildSessionClApiRequestInit(options)
  );
  if (
    response.status === 401 &&
    options.credential.credentialKind ===
      SessionRequestCredentialKind.AccessToken
  ) {
    options.onUnauthorized?.(options.credential.token);
  }
  return response;
}

function buildSessionClApiRequestInit(
  options: SessionClApiRequestOptions
): RequestInit {
  const init: RequestInit = {
    method: options.method ?? "GET",
    headers: {
      ...desktopClientAttributionHeaders(),
      ...options.headers,
      Authorization: `Bearer ${options.credential.token}`,
    },
    signal: options.signal
      ? AbortSignal.any([
          options.signal,
          AbortSignal.timeout(options.timeoutMs),
        ])
      : AbortSignal.timeout(options.timeoutMs),
  };
  if (options.body !== undefined) {
    init.body = options.body;
  }
  if (options.cache !== undefined) {
    init.cache = options.cache;
  }
  return init;
}

function buildSessionClApiUrl(
  apiOrigin: string,
  path: string,
  query?: Record<string, string | null | undefined> | URLSearchParams
): URL {
  const url = new URL(path, apiOrigin);
  if (!query) {
    return url;
  }
  const entries =
    query instanceof URLSearchParams ? query.entries() : Object.entries(query);
  for (const [key, value] of entries) {
    if (value !== null && value !== undefined) {
      url.searchParams.append(key, value);
    }
  }
  return url;
}

async function sendSessionJson(
  options: SessionFetchOptions,
  method: "POST",
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
  try {
    // Recheck even when sign-out made the awaited token refresh return null.
    if (requestOptions?.canStillSend?.() === false || !accessToken) {
      return { kind: "no_session" };
    }
    const apiOrigin = options.getApiOrigin();
    if (!apiOrigin) {
      return { kind: "no_origin" };
    }
    try {
      new URL(path, apiOrigin);
    } catch {
      return { kind: "no_origin" };
    }
    const response = await sendSessionClApiRequest({
      apiOrigin,
      path,
      method,
      fetch: options.fetch,
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        ...requestOptions?.headers,
      },
      body: JSON.stringify(body),
      timeoutMs: requestOptions?.timeoutMs ?? DEFAULT_SESSION_FETCH_TIMEOUT_MS,
      signal: requestOptions?.signal,
      credential: {
        token: accessToken,
        credentialKind: SessionRequestCredentialKind.AccessToken,
      },
    });
    return { kind: "response", response, accessToken };
  } catch (error) {
    if (isAbortTimeoutError(error)) {
      return { kind: "timeout" };
    }
    return { kind: "network_error", error };
  }
}

/**
 * As much of a response body as a caller allowed itself to hold, and whether the
 * peer had more to say than that.
 *
 * `truncated` is not a detail — it is the caller's instruction NOT to parse: a
 * body cut mid-token is not a body any parser may be handed, and a code read out
 * of one would be a code nobody sent.
 */
export type BoundedResponseText = {
  text: string;
  truncated: boolean;
};

/**
 * Read at most `maxBytes` of a response body, abandoning the stream at the bound.
 *
 * `response.text()` buffers the WHOLE body before any cap can be applied, so
 * capping afterwards bounds the PARSE and not the ALLOCATION. On a failure path
 * that repeats every sync tick the body is attacker- or infrastructure-shaped —
 * a proxy or WAF answering a non-2xx with an arbitrarily large page — and the
 * peer must not get to choose how much of this process's memory it occupies.
 * Reading incrementally and cancelling the reader at the cap moves that decision
 * back to us.
 *
 * A cap in BYTES, not characters: they diverge on any multi-byte UTF-8 body, and
 * bytes are what is actually allocated.
 */
export async function readBoundedResponseText(
  response: Response,
  maxBytes: number
): Promise<BoundedResponseText> {
  const stream = response.body;
  if (!stream) {
    return { text: "", truncated: false };
  }
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let text = "";
  let bytesRead = 0;
  try {
    let finished = false;
    while (!finished) {
      const chunk = await reader.read();
      if (chunk.done) {
        finished = true;
        text += decoder.decode();
        continue;
      }
      bytesRead += chunk.value.byteLength;
      if (bytesRead > maxBytes) {
        return { text, truncated: true };
      }
      text += decoder.decode(chunk.value, { stream: true });
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  return { text, truncated: false };
}
