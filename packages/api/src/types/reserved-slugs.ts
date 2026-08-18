import { z } from "zod";

/**
 * Org slugs that collide with top-level routes outside the org-scoped layout.
 *
 * All authenticated routes live under /{orgSlug}/..., so they can't collide.
 * Only routes that exist outside that scope need to be reserved.
 */
export const RESERVED_ORG_SLUGS = [
  // Unauthenticated / onboarding routes
  "sign-in",
  "sign-up",
  "onboarding",

  // API and system routes
  "api",
  "d",
  "rum-validation",

  // Auth flow paths
  "auth",
  "sso",
  "oauth",
  "callback",
  // PRD-562 / PLN-1526: the GitHub-first desktop connect entry and the SSO
  // handshake landing route. Both live in the `(unauthenticated)` group, i.e.
  // outside the org-scoped layout, so an org that claimed either slug would be
  // shadowed by the static route. `sso` and `callback` above do NOT cover these
  // — this list is matched on the whole first segment, not by prefix.
  "connect",
  "sso-callback",

  // Next.js / infrastructure
  "_next",
] as const;

const reservedOrgSlugSet = new Set<string>(RESERVED_ORG_SLUGS);

export function isReservedOrgSlug(slug: string): boolean {
  return reservedOrgSlugSet.has(slug.toLowerCase());
}

const ORG_SLUG_MIN_LENGTH = 2;
const ORG_SLUG_MAX_LENGTH = 64;
const ORG_SLUG_FORMAT = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;

export const orgSlugSchema = z
  .string()
  .min(
    ORG_SLUG_MIN_LENGTH,
    `Slug must be at least ${ORG_SLUG_MIN_LENGTH} characters`
  )
  .max(
    ORG_SLUG_MAX_LENGTH,
    `Slug must be at most ${ORG_SLUG_MAX_LENGTH} characters`
  )
  .regex(
    ORG_SLUG_FORMAT,
    "Slug must contain only lowercase letters, numbers, and hyphens, and cannot start or end with a hyphen"
  )
  .refine(
    (s) => !isReservedOrgSlug(s),
    "This slug is reserved and cannot be used"
  );

/**
 * Characters that make an org slug unsafe to interpolate into a redirect path.
 * Every caller interpolates this value RAW into a `redirect()` target
 * (`/${orgSlug}/sessions`), so any character with structural URL meaning can
 * reshape that destination rather than name a path segment:
 *
 * - "/" or "\" (a path/back separator) reshape the path or, combined with a
 *   leading form, forge an off-site / protocol-relative open redirect.
 * - "?" or "#" open a query string or fragment, so a slug like `foo?next=…`
 *   would splice a query/fragment onto the redirect target. Next decodes the
 *   route param before it reaches this gate, so an encoded `%3F`/`%23` arrives
 *   here as a literal "?"/"#" and is caught by the same rule.
 * - "%" is rejected so a double-encoded payload (`%253F` → decoded once to
 *   `%3F`) cannot survive this gate still-encoded and be decoded into a "?" by
 *   a later navigation.
 *
 * ASCII control characters (0x00-0x1f, incl. NUL) plus DEL have no place in a
 * URL path segment either. Everything else, including underscores, uppercase,
 * and plain spaces (as used by the legacy Clerk-id slug fallback), is left
 * alone on purpose — the gate blocks path/redirect reshaping, not every
 * non-slug character.
 */
const SLUG_UNSAFE_CHARS = /[/\\?#%]/;
const CONTROL_CHAR_MAX_CODE_POINT = 0x1f;
const DEL_CODE_POINT = 0x7f;

function hasControlCharacter(value: string): boolean {
  for (const char of value) {
    const code = char.codePointAt(0) ?? 0;
    if (code <= CONTROL_CHAR_MAX_CODE_POINT || code === DEL_CODE_POINT) {
      return true;
    }
  }
  return false;
}

/**
 * Redirect-safety gate for an `orgSlug` about to be interpolated into a same-site
 * redirect path (e.g. legacy `/loops` and `/loops/monitoring` bookmarks landing
 * on Sessions).
 *
 * This is deliberately looser than {@link orgSlugSchema}, which only accepts the
 * kebab-case shape assigned to *new* orgs. `findOrCreateByClerkId` falls back to
 * writing the raw Clerk org id (e.g. `org_2ab...`, underscores + mixed case) as
 * the slug when Clerk has no slug, and the organization route preserves those
 * legacy values. Validating a redirect against `orgSlugSchema` would 404 an old
 * bookmark for one of those orgs instead of forwarding it. We only need to block
 * the shapes that could forge an open redirect or reshape the path, so we accept
 * any non-empty segment that carries no path/query/fragment separator, no "%"
 * (double-encoding survival), and no control character. A leading "." (e.g.
 * "..") is also rejected so a slug cannot climb the path.
 */
export function isPathSafeSlug(slug: string): boolean {
  return (
    slug.length > 0 &&
    !slug.startsWith(".") &&
    !SLUG_UNSAFE_CHARS.test(slug) &&
    !hasControlCharacter(slug)
  );
}
