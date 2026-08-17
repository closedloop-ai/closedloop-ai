// Single source of truth for the cross-surface navigation "referrer" contract
// (FEA-4262). When a cross-link jumps between two peer detail surfaces — e.g.
// a session's Branch link opening the branch-detail page — the destination
// carries `?from=<surface>` so its "Back" affordance can return to the
// REFERRING surface instead of the static list it normally falls back to.
//
// This is client navigation state with no `apps/api` consumer, so it lives in
// the shared client app package (`@repo/app/shared/lib`) rather than the
// `packages/api` transport-contract package (whose types must be shared by both
// `apps/app` and `apps/api`). Both the web app and the desktop renderer consume
// it, so the param name and its accepted values live here and can never drift
// between surfaces. Kept lightweight and dependency-free (no Zod, no component
// imports) so bundle-sensitive client shells import only the constant +
// validator.

/** Query-string key a peer-surface cross-link sets to name where it came from. */
export const NAV_FROM_PARAM = "from";

/**
 * The peer detail surfaces a `?from=` referrer can name. This is a whitelist:
 * only these values are honored when resolving a "Back" target, so an arbitrary
 * or attacker-supplied `from` value can never redirect Back anywhere else (it
 * falls through to the surface's own static back href).
 */
export const NavReferrerSurface = {
  Session: "session",
  Branch: "branch",
} as const;
export type NavReferrerSurface =
  (typeof NavReferrerSurface)[keyof typeof NavReferrerSurface];

/**
 * Narrow a raw `?from=` query value to a known {@link NavReferrerSurface}, or
 * `undefined` when it is absent/unrecognized. Unknown values degrade to
 * `undefined` so the caller keeps its existing static back behavior — a missing
 * or bogus referrer is never fatal.
 */
export function resolveNavReferrerSurface(
  raw: string | null | undefined
): NavReferrerSurface | undefined {
  if (raw === NavReferrerSurface.Session || raw === NavReferrerSurface.Branch) {
    return raw;
  }
  return undefined;
}

/**
 * Append the `?from=<surface>` referrer to a forward cross-link href so the
 * destination surface can honor where the user came from. Preserves any existing
 * query string on the href. Additive: destinations that do not yet read the
 * param simply ignore it.
 */
export function withNavReferrer(
  href: string,
  surface: NavReferrerSurface
): string {
  const separator = href.includes("?") ? "&" : "?";
  return `${href}${separator}${NAV_FROM_PARAM}=${surface}`;
}
