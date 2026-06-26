/**
 * @file admin-billing.ts
 * @description Desktop-main (ESM) shared foundation for the vendor billing
 * "admin" clients used by nightly cost reconciliation (FEA-1435/1436). It holds
 * the normalized billed-entry shape, an injectable fetch surface, the
 * network-allowlist guard, and a small JSON request helper. The vendor-specific
 * URL building and response parsing live in anthropic-admin-client.ts /
 * openai-admin-client.ts.
 *
 * ── Security posture ─────────────────────────────────────────────────────────
 * These clients carry an org-level Admin key. Two rules are enforced here:
 *   1. The Admin key is sent ONLY in request headers, NEVER in the URL/query
 *      (query strings leak into logs and referrers). Callers pass headers.
 *   2. Every outbound request host is checked against a fixed allowlist
 *      (api.anthropic.com / api.openai.com) via assertAllowedAdminHost, so a
 *      misconfigured base URL can never ship the Admin key to another host.
 * Errors thrown here include the HTTP status and a truncated copy of the
 * vendor's error body, scrubbed of any key-shaped token via redactKeyLikeTokens.
 * We only ever put the key in request headers, but the vendor's *response* is
 * outside our control — OpenAI's 401 body, for instance, echoes a masked copy of
 * the key it received — so we redact before the body can reach an error message,
 * an IPC reply, or the log file. The key itself is never placed in an error.
 */
import {
  centsToMicroCents,
  parseDecimalCentsToMicroCents,
  usdToMicroCents,
} from "./cost-math.js";

/** A single vendor-billed line, normalized to the reconciliation grain. */
export type VendorBilledEntry = {
  /** UTC calendar day, ISO `YYYY-MM-DD`, derived from the time bucket start. */
  day: string;
  /** Vendor-reported model id, or null when the vendor does not break out per model. */
  model: string | null;
  /** Billed amount for this entry, in integer micro-cents (see cost-math.ts). */
  amountMicroCents: number;
  /** Vendor cost descriptor for diagnostics (Anthropic cost_type / OpenAI line_item). */
  label: string | null;
};

/** One parsed page of a paginated billing response. */
export type ParsedBillingPage = {
  entries: VendorBilledEntry[];
  hasMore: boolean;
  nextPage: string | null;
};

/** Minimal Response surface the clients depend on (a structural subset of fetch's Response). */
export type AdminFetchResponse = {
  readonly ok: boolean;
  readonly status: number;
  json(): Promise<unknown>;
  text(): Promise<string>;
};

/** Injectable fetch so tests can mock the network without touching it. */
export type AdminFetchLike = (
  url: string,
  init: { method: "GET"; headers: Record<string, string> }
) => Promise<AdminFetchResponse>;

/** Default fetch implementation (Electron main / Node global fetch). */
export const DEFAULT_ADMIN_FETCH: AdminFetchLike = async (url, init) => {
  return fetch(url, init);
};

/** Hosts the admin clients are permitted to contact. */
export const ANTHROPIC_API_HOST = "api.anthropic.com";
export const OPENAI_API_HOST = "api.openai.com";

/**
 * Throw unless `url` is https and its host exactly matches `allowedHost`. This
 * is the network allowlist: it guarantees the Admin key can only ever leave the
 * machine toward the intended vendor host.
 */
export function assertAllowedAdminHost(url: string, allowedHost: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error("Admin API URL is not a valid URL");
  }
  if (parsed.protocol !== "https:") {
    throw new Error(`Admin API URL must use https (got ${parsed.protocol})`);
  }
  if (parsed.host !== allowedHost) {
    throw new Error(
      `Admin API host not allowed: ${parsed.host} (expected ${allowedHost})`
    );
  }
}

/**
 * Redact anything that looks like an API key from a string before it is placed
 * in a thrown error or a log line. We send the Admin key only in request headers,
 * but a vendor's error *response* is outside our control and can echo a copy of
 * the key it received — e.g. OpenAI's 401 body: "Incorrect API key provided:
 * sk-admin-…". The token class matches the characters a real key is made of
 * (alphanumerics, `-`, `_`) plus `*` to also catch the asterisk-masked forms
 * vendors print; it deliberately excludes `.` so a trailing sentence period is
 * left intact. The full (unmasked) key is the only true secret and is always a
 * contiguous run of these characters, so it is always fully scrubbed. Over-
 * redaction is the intended posture: a secret leak is far worse than a slightly
 * noisier diagnostic.
 */
export function redactKeyLikeTokens(text: string): string {
  return text.replace(/sk-[A-Za-z0-9*_-]{4,}/g, "sk-[redacted]");
}

/**
 * GET `url` with `headers`, returning the parsed JSON body. Throws on a non-2xx
 * with the status and a truncated, key-scrubbed copy of the vendor's error body.
 * The Admin key is only ever in the request headers; redactKeyLikeTokens scrubs
 * any key-shaped token the vendor may echo back, so the key never lands in the
 * thrown error.
 */
export async function requestAdminJson(
  url: string,
  headers: Record<string, string>,
  fetchImpl: AdminFetchLike,
  vendorLabel: string
): Promise<unknown> {
  let response: AdminFetchResponse;
  try {
    response = await fetchImpl(url, { method: "GET", headers });
  } catch (err) {
    // The fetch call can throw BEFORE any response — most notably for an
    // invalid header value, whose message echoes the raw header (the Admin key).
    // Scrub any key-shaped token before the message can reach a thrown error,
    // an IPC reply, or the log file. (setKey already rejects non-header-safe
    // keys; this is defense in depth for a key stored before that guard, and
    // for any other transport error that might surface key-shaped text.)
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(
      `${vendorLabel} admin API request failed: ${redactKeyLikeTokens(message)}`
    );
  }
  if (!response.ok) {
    let bodyHint = "";
    try {
      const body = await response.text();
      // Redact before truncating so a key straddling the 200-char cut can't
      // survive in a half-scrubbed form.
      bodyHint = body ? `: ${redactKeyLikeTokens(body).slice(0, 200)}` : "";
    } catch {
      bodyHint = "";
    }
    throw new Error(
      `${vendorLabel} admin API HTTP ${response.status}${bodyHint}`
    );
  }
  return response.json();
}

/** Narrow an unknown to a plain object, else null. */
export function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : null;
}

/** UTC `YYYY-MM-DD` from an RFC 3339 timestamp string; throws if unparseable. */
export function utcDayFromRfc3339(value: unknown, vendorLabel: string): string {
  if (typeof value !== "string") {
    throw new Error(`${vendorLabel} billing: time bucket start is missing`);
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new Error(`${vendorLabel} billing: invalid time bucket start`);
  }
  return date.toISOString().slice(0, 10);
}

/** UTC `YYYY-MM-DD` from a Unix-seconds timestamp; throws if non-finite. */
export function utcDayFromUnixSeconds(
  value: unknown,
  vendorLabel: string
): string {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`${vendorLabel} billing: time bucket start is missing`);
  }
  return new Date(value * 1000).toISOString().slice(0, 10);
}

// Re-export the unit converters the vendor parsers use, so the clients import
// money math from one place.
export { centsToMicroCents, parseDecimalCentsToMicroCents, usdToMicroCents };
