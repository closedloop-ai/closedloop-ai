import {
  ANALYTICS_REDACTION_MARKER,
  SENSITIVE_QUERY_PARAM_KEYS,
} from "./sensitive-query-params";

/**
 * Serialize `searchParams` with every sensitive value replaced by
 * {@link ANALYTICS_REDACTION_MARKER}, preserving key order and repeated keys.
 *
 * This is the `$pageview` half, and it is the only half that sees DECODED key
 * names: `useSearchParams()` has already percent-decoded them, so `?%73tate=`
 * arrives here spelled `state` and matches. Every other path reads a raw href
 * — see `./redact-analytics-url` for the half that has to decode for itself.
 */
export function redactedSearchString(searchParams: URLSearchParams): string {
  const redacted = new URLSearchParams();
  for (const [key, value] of searchParams) {
    redacted.append(
      key,
      SENSITIVE_QUERY_PARAM_KEYS.has(key) ? ANALYTICS_REDACTION_MARKER : value
    );
  }
  return redacted.toString();
}
