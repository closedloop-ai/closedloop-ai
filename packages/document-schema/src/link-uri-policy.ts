/**
 * Schemes permitted on link marks. Anything with another explicit scheme
 * (javascript:, data:, ftp:, tel:, …) is rejected. Schemeless URLs (relative
 * paths and in-page #fragments) are not subject to this allowlist and are left
 * to the editor's built-in validation.
 *
 * Modeled as a const object (not an array) per the repo enum convention so the
 * allowed set is a single typed source of truth with derived runtime membership.
 */
export const AllowedLinkScheme = {
  Http: "http",
  Https: "https",
  Mailto: "mailto",
} as const;

export type AllowedLinkScheme =
  (typeof AllowedLinkScheme)[keyof typeof AllowedLinkScheme];

/** Runtime membership set derived from {@link AllowedLinkScheme}. */
const ALLOWED_LINK_SCHEME_VALUES: ReadonlySet<string> = new Set(
  Object.values(AllowedLinkScheme)
);

/** True when `scheme` (already lower-cased) is on the link-mark allowlist. */
export function isAllowedLinkScheme(
  scheme: string
): scheme is AllowedLinkScheme {
  return ALLOWED_LINK_SCHEME_VALUES.has(scheme);
}

/** Captures the leading URI scheme (e.g. "http" from "http://x"), if any. */
const SCHEME_REGEX = /^([a-z][a-z0-9+.-]*):/i;

/**
 * Highest code point a browser treats as leading "C0 control or space" and
 * strips from the front of a URL before reading its scheme (U+0000–U+0020).
 */
const MAX_LEADING_STRIP_CODE_POINT = 0x20;

/** ASCII tab (U+0009), LF (U+000A) and CR (U+000D). */
const ASCII_TAB_OR_NEWLINE_REGEX = /[\t\n\r]/g;

/**
 * Normalize a candidate URL the way a browser does before resolving it, so a
 * dangerous scheme cannot hide behind leading whitespace/control characters or
 * an embedded tab/newline (e.g. " ftp://x", "\tjavascript:x", "java\nscript:x").
 *
 * Mirrors the WHATWG URL parser: it strips leading C0 controls and space, then
 * removes every ASCII tab/newline from the rest of the input before it reads
 * the scheme. Detection-only — the ORIGINAL string is still handed to the
 * editor's validator so schemeless relative/fragment links keep their behavior.
 */
function normalizeForSchemeDetection(url: string): string {
  let start = 0;
  while (
    start < url.length &&
    url.charCodeAt(start) <= MAX_LEADING_STRIP_CODE_POINT
  ) {
    start += 1;
  }
  return url.slice(start).replace(ASCII_TAB_OR_NEWLINE_REGEX, "");
}

/**
 * Link-protocol policy for the Tiptap Link mark's `isAllowedUri` hook.
 *
 * Pins the allowed schemes so the policy can't silently change across Tiptap
 * upgrades. `isAllowedUri` is the real XSS gate in Tiptap v3 — it guards
 * setLink, toggleLink, paste, parseHTML and renderHTML — so applying it here is
 * defense-in-depth that also covers non-toolbar callers (e.g. programmatic API
 * consumers).
 *
 * @param url - The candidate href.
 * @param defaultValidate - Tiptap's built-in validator, used for schemeless
 *   URLs so relative/fragment links keep working.
 */
export function isAllowedLinkUri(
  url: string,
  defaultValidate: (url: string) => boolean
): boolean {
  const scheme = normalizeForSchemeDetection(url)
    .match(SCHEME_REGEX)?.[1]
    ?.toLowerCase();
  if (scheme && !isAllowedLinkScheme(scheme)) {
    return false;
  }
  return defaultValidate(url);
}
