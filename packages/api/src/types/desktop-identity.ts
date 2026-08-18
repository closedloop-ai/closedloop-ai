/**
 * Display identity for the authenticated first-party desktop session
 * (FEA-2219). Returned by `GET /desktop/identity` and shown on the desktop
 * Settings → Account tab so a signed-in user sees their name/email and
 * organization name rather than the raw database ids the session token carries.
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
   * artifact routes are scoped by (`/<orgSlug>/issues/<slug>`). The desktop
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
   * FEA-4169 — the server-owned ORG POLICY controlling whether local desktop
   * session data (metadata + transcripts) may sync to the cloud at all. This is
   * the OUTER gate ABOVE per-device sync consent (PRD-542/FEA-4103): when
   * `false`, NO session data egresses regardless of the sync-observability tier a
   * user chose locally; when `true`, the existing per-tier consent gates apply as
   * before.
   *
   * Additive + optional for version skew: an OLD server that predates this field
   * omits it entirely, and the desktop must degrade to the prior device-consent
   * behavior (treat "field absent" as "no org policy → keep current behavior")
   * rather than fail-closed, so upgrading the desktop before the server never
   * suppresses sync for existing users. A NEW server always sends an explicit
   * boolean (default `false` for orgs, `true` for the enabled Closedloop org).
   */
  sessionSyncPolicyEnabled?: boolean;
  /**
   * ISS-4705 — a versioned capability marker declaring that this server
   * understands the `sessionSyncPolicyEnabled` org-sync policy and always emits
   * an explicit value for it. It exists to disambiguate two field-absent shapes
   * that presence-of-`sessionSyncPolicyEnabled` alone cannot tell apart:
   *
   * - an OLD server that predates the policy entirely (omits BOTH this marker and
   *   `sessionSyncPolicyEnabled`) — genuine version skew, safe to degrade to the
   *   prior device-consent behavior, and
   * - a BUGGY CURRENT server that supports the policy (sends this marker `true`)
   *   but drops ONLY `sessionSyncPolicyEnabled` from an otherwise well-formed
   *   response — which must NOT be read as "no org policy" and must fail closed.
   *
   * Additive + optional for version skew: an OLD server omits it, and the desktop
   * treats "marker absent" as "old server → skew degrade". A capable server
   * always sends `true`. When present it is always `true`; there is no reason for
   * a capable server to advertise `false`, so `false`/absent are equivalent
   * (old-server / no capability) at the consumer.
   */
  sessionSyncPolicySupported?: boolean;
};
