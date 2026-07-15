import { AllowedLinkScheme } from "./link-uri-policy";

/**
 * Protocols that are safe to store on a link mark and render as an active
 * `<a href>`. Everything else — most importantly `javascript:`, `data:` and
 * `vbscript:` — is rejected so user-typed URLs cannot become an XSS vector.
 *
 * Derived from the single source of truth in `link-uri-policy.ts` (which the
 * Tiptap `isAllowedUri` hook also enforces) so the toolbar and the editor hook
 * can never silently disagree about what's allowed. `URL.protocol` yields the
 * scheme with a trailing colon (e.g. `"https:"`), hence the `+ ":"`.
 */
const SAFE_PROTOCOLS = new Set(
  Object.values(AllowedLinkScheme).map((scheme) => `${scheme}:`)
);

/**
 * Validates a user-supplied link URL before it is stored on a Tiptap link mark.
 *
 * Returns `null` only for empty input or an absolute URL whose scheme is not in
 * the allowlist (e.g. `javascript:`, `data:`, `vbscript:`). Bare fragments
 * (`#section`) and scheme-less relative URLs (`example.com`, `/docs`) are
 * accepted as typed — they carry no scheme, so they cannot be an XSS vector,
 * and rejecting them would regress the toolbar's prior accept-everything
 * behavior for the most common link inputs.
 *
 * The check relies on WHATWG URL parsing: any dangerous scheme parses
 * successfully (so its protocol is caught by the allowlist) and normalizes away
 * embedded tab/newline/control-char tricks (e.g. `java\nscript:`) first; only
 * genuinely scheme-less input throws, and the browser later resolves that same
 * string as a relative href.
 */
export function sanitizeLinkUrl(url: string): string | null {
  const trimmed = url.trim();

  if (trimmed === "") {
    return null;
  }

  // Bare fragment links stay on the current page; there is no protocol to vet.
  if (trimmed.startsWith("#")) {
    return trimmed;
  }

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    // No parseable absolute scheme → a relative URL, which cannot smuggle a
    // dangerous protocol. Preserve it as the user typed it.
    return trimmed;
  }

  return SAFE_PROTOCOLS.has(parsed.protocol) ? trimmed : null;
}
