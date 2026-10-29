/**
 * Display identity for the authenticated first-party desktop session
 * (FEA-2219). Returned by `GET /desktop/identity` and shown in the desktop
 * renderer so a signed-in user sees their name/email and organization name rather than the raw database ids the session token carries.
 *
 * Shared here (per the "never define the same contract twice" rule) so the API
 * route that produces it and the desktop main process that consumes it agree on
 * one shape.
 */
export type DesktopIdentity = {
  userId: string;
  organizationId: string;
  email: string;
  firstName: string | null;
  lastName: string | null;
  organizationName: string | null;
  /**
   * ISS-4898 — the organization's URL slug, which is what the web app's
   * artifact routes are scoped by (`/<orgSlug>/documents/<slug>`). The desktop
   * renderer previously held only an `organizationId`, so it could not build a
   * web URL for a linked artifact at all and its session-detail pills had to
   * stay inert labels. With the slug it can hand the OS browser a real
   * destination.
   *
   * Additive + optional for version skew: an OLD server omits it entirely, and
   * the desktop must degrade to the prior inert-pill behavior rather than
   * building a URL from a missing segment. Omitted — never serialized as
   * `null` — when the user's organization row could not be read, so an old
   * client's `.passthrough()` schema is unaffected either way.
   */
  organizationSlug?: string | null;
  /**
   * Retired by ISS-11449: the org session-sync policy no longer exists, and no
   * current consumer reads either field. A current server still sends both as
   * `true`, because desktops built before ISS-11449 run an org-policy store that
   * keeps a cached `false` whenever these fields go absent, and an explicit
   * `true` is what releases it. Remove once those builds no longer connect.
   */
  sessionSyncPolicyEnabled?: boolean;
  sessionSyncPolicySupported?: boolean;
  /**
   * ISS-11465 — the ORGANIZATION's logo and the USER's avatar, so the desktop
   * workspace menu renders what the web one already does instead of falling back
   * to a bare initial. The desktop renderer has no Clerk client of its own (web
   * reads `organization.imageUrl` / `user.imageUrl` straight from Clerk hooks),
   * so this response is the only route these values can reach it by.
   *
   * Additive + optional for version skew, exactly as `organizationSlug` above:
   * an OLD server omits them entirely and the desktop must degrade to the
   * initial-letter fallback it renders today. OMITTED rather than serialized as
   * `null` when absent, so an old client's `.passthrough()` schema is unaffected
   * and no consumer is invited to render an empty `src`.
   *
   * NEITHER is guaranteed to be Clerk-hosted. The org logo is read from Clerk
   * (`https://img.clerk.com`, which the desktop renderer CSP admits on `img-src`
   * — ISS-10402), but `userImageUrl` comes from our own `User.avatarUrl` column,
   * which `PUT /users/:id` accepts any valid URL into. The desktop renderer
   * therefore screens every value against its own policy before rendering it
   * (`isRendererDisplayableImageUrl`) rather than trusting the origin here.
   *
   * Typed `string | null` rather than `string` because that is what actually
   * crosses the boundary: the producer omits an absent value, and the desktop's
   * own schema accepts an explicit `null` as well so one unexpected null is not
   * a whole-payload rejection.
   */
  organizationImageUrl?: string | null;
  userImageUrl?: string | null;
};
