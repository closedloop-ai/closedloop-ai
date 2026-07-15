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
