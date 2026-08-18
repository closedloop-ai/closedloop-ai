/**
 * @file require-https.ts
 * @description Tiny shared network-validation primitive for desktop-main
 * outbound fetches: parse a URL and reject anything that is not `https:`. Both
 * the admin-billing allowlist guard (`assertAllowedAdminHost`) and the
 * coaching-pack distribution downloader carry the same "attacker-influenceable
 * URL must be cleartext-free" requirement, so the parse+protocol check lives in
 * one place instead of being re-implemented per call site.
 *
 * NOTE: this only vets the ORIGINAL URL's scheme. It does NOT follow or
 * re-validate redirects — callers that fetch attacker-influenceable URLs must
 * still pass `redirect: "error"` so a 3xx to http/an internal host cannot slip
 * past this guard.
 */

/**
 * Parse `url` and return the `URL` iff it is `https:`. Throws a caller-supplied
 * (or default) message on a malformed URL or a non-https protocol.
 *
 * @param url raw URL string to validate.
 * @param label human-readable subject used in the thrown error (e.g.
 *   "asset download URL", "Admin API URL"). Defaults to "URL".
 */
export function requireHttps(url: string, label = "URL"): URL {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`${label} is not a valid URL`);
  }
  if (parsed.protocol !== "https:") {
    throw new Error(`${label} must use https (got ${parsed.protocol})`);
  }
  return parsed;
}
