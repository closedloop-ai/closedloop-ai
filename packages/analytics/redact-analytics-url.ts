import {
  ANALYTICS_REDACTION_MARKER,
  SENSITIVE_QUERY_PARAM_KEYS,
} from "./sensitive-query-params";

const PLUS_SIGNS = /\+/g;

/**
 * Redact the sensitive query values in a raw url string, matching query keys
 * the way the FRAMEWORK matches them rather than the way posthog-js does.
 *
 * posthog-js's own `maskQueryParams` compares the raw key segment against its
 * masked list (`utils/request-utils.ts:104` in the resolved 1.359.1), so
 * `?%73tate=<secret>` is not masked even though `new URL(...).searchParams` —
 * and therefore the authorize route — reads it as `state` (ISS-8307). One
 * percent-decode of the key is exactly what `URLSearchParams` does, so this
 * matches the same spellings the route does and no more: `%2573tate` decodes to
 * `%73tate` for both, and neither reads it as `state`.
 *
 * Returns the input BYTE-IDENTICAL when no sensitive key carried a non-empty
 * value, so an unrelated url is never marked as having been redacted. The
 * non-sensitive params, the path, the ordering, duplicates, and any malformed
 * text are preserved on the paths that do rewrite.
 */
export function redactAnalyticsUrl(url: string): string {
  const hashAt = url.indexOf("#");
  const beforeHash = hashAt === -1 ? url : url.slice(0, hashAt);
  const hash = hashAt === -1 ? "" : url.slice(hashAt);

  // Only the top-level query is a query. A `?` inside the FRAGMENT is left
  // alone deliberately: `URLSearchParams` does not read it as a param either,
  // so the authorize route could not consume a secret spelled there. That holds
  // only while no surface here uses hash routing — a hash-routed page carrying
  // `#/cb?state=` would need this widened.
  const queryAt = beforeHash.indexOf("?");
  if (queryAt === -1) {
    return url;
  }

  const base = beforeHash.slice(0, queryAt);
  const parts = beforeHash.slice(queryAt + 1).split("&");

  let redactedAny = false;
  const rewritten = parts.map((part) => {
    const redacted = redactQueryPart(part);
    if (redacted !== part) {
      redactedAny = true;
    }
    return redacted;
  });

  if (!redactedAny) {
    return url;
  }
  return `${base}?${rewritten.join("&")}${hash}`;
}

function redactQueryPart(part: string): string {
  const equalsAt = part.indexOf("=");
  if (equalsAt === -1) {
    return part;
  }
  const rawKey = part.slice(0, equalsAt);
  const rawValue = part.slice(equalsAt + 1);
  // No marker where nothing sensitive was actually carried: a bare `?state=`
  // has no secret in it, and rewriting it would claim a redaction happened.
  if (rawValue === "" || rawValue === ANALYTICS_REDACTION_MARKER) {
    return part;
  }
  if (!SENSITIVE_QUERY_PARAM_KEYS.has(decodeQueryKey(rawKey))) {
    return part;
  }
  return `${rawKey}=${ANALYTICS_REDACTION_MARKER}`;
}

function decodeQueryKey(rawKey: string): string {
  const withSpaces = rawKey.replace(PLUS_SIGNS, " ");
  try {
    return decodeURIComponent(withSpaces);
  } catch {
    // A malformed escape is not a spelling of anything; compare it as written.
    return rawKey;
  }
}
