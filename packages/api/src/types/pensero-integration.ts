/**
 * The wire contract for the per-organization Pensero credential (ISS-8007).
 *
 * Declared ONCE here because both halves of the boundary consume it: the route
 * in `apps/api/app/settings/pensero/route.ts` produces it, and the client hook
 * in `packages/app/pensero/hooks/use-pensero-integration.ts` consumes it. Two
 * structurally identical declarations typecheck independently, so a field added
 * or renamed on one side stays green on the other until a render silently reads
 * `undefined` — which is the drift this module exists to make impossible.
 *
 * SECURITY: there is no `token` field, and there is no shape here that carries
 * one. The server never returns the stored credential; what a client may learn
 * is presence, a last-four fingerprint, the non-secret endpoint, and when it was
 * written. A masked token a client could read back is a recoverable secret with
 * extra steps, so none is offered.
 *
 * Dependency-free by design, like every module in this directory.
 */

/**
 * The BFF path every Pensero credential verb shares: `GET`, `PUT`, and `DELETE`
 * on `apps/api/app/settings/pensero/route.ts`. The route's own address is its
 * file location, so this constant is what the client hook, the desktop write
 * allowlist, and the tests import instead of restating the string.
 */
export const PENSERO_INTEGRATION_PATH = "/settings/pensero";

/** Metadata about one organization's stored Pensero credential. Never the token. */
export type PenseroCredentialInfoResponse = {
  /** Whether a credential row exists for this organization. */
  isSet: boolean;
  /** Last four characters of the stored token — a fingerprint, not a prefix. */
  lastFour: string | null;
  /** The org's base-URL override, or null when it inherits the deployment default. */
  baseUrl: string | null;
  /**
   * Provider team identifiers this org's scheduled poll is narrowed to
   * (ISS-8761). EMPTY means "do not narrow" — the `team_identifiers` parameter
   * is omitted entirely and Pensero answers for all teams. Not secret, so
   * unlike the token it is readable.
   *
   * OPTIONAL ACROSS THE DEPLOY BOUNDARY (whitlockk, #6492). `apps/app` and
   * `apps/api` deploy independently, so a newer web build reaches an older API
   * that does not send this field at all. Declaring it required would make the
   * shared type describe a response the supported skew window can genuinely
   * produce and TypeScript would silently vouch for it; consumers read it as
   * `?? []`, which is the same "do not narrow" the empty list means.
   */
  teamIdentifiers?: string[];
  /** When the credential was last written, ISO-8601. */
  setAt: string | null;
};

/**
 * The PUT body. `baseUrl: null` (or omitted) CLEARS a previous override so the
 * org falls back to the deployment default rather than keeping a stale host.
 *
 * `teamIdentifiers` does NOT follow that shape, and the difference is
 * deliberate (codex + whitlockk, #6492). An empty array means "do not narrow";
 * OMITTING the key means "leave the stored list alone". `baseUrl` can collapse
 * those two because every client that writes a credential can also see and
 * restate the base URL — but the team field is behind a closed-by-default flag,
 * so a client with the control hidden has no way to restate a list it cannot
 * read. Under whole-configuration semantics an admin rotating a token with the
 * flag off would silently clear a narrowing they never touched, and the next
 * cron would start polling every team on their behalf.
 */
export type SetPenseroCredentialRequest = {
  token: string;
  baseUrl?: string | null;
  teamIdentifiers?: string[];
};

/** The DELETE response. Removing an absent credential is idempotent, not an error. */
export type RemovePenseroCredentialResponse = {
  deleted: true;
};

/**
 * Why a REFUSED write carries a code at all: the route already answers 403 to a
 * non-admin (and 503 when it could not read their role), and the refusals mean
 * different things to a programmatic
 * caller — one is "you may never do this", the other is "not yet". Without a
 * discriminator an integration retrying after GA cannot tell them apart. Shared
 * here because the Settings credential card reads it too (ISS-10316): a real
 * admin refused by the rollout must not be told they need an admin.
 */
export const PenseroRouteErrorCode = {
  /** The caller is an org admin, but the rollout is not on for them. */
  RolloutDisabled: "pensero_rollout_disabled",
} as const;
export type PenseroRouteErrorCode =
  (typeof PenseroRouteErrorCode)[keyof typeof PenseroRouteErrorCode];
