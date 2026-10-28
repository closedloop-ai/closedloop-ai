import {
  type SignedInUserIdentity,
  sameUserIdentity,
} from "../util/user-identity.js";

/**
 * ISS-9418 / ISS-8610 — the auth-session → sync-lane recovery seam, and the
 * identity diff that decides which of its two doors an auth-state notification
 * opens.
 *
 * ISS-11449 is why this file is named for auth sessions rather than for the org
 * sync policy it was extracted for (ISS-4623). That policy is gone; what the
 * module was ALSO carrying — and the only reason it still exists — is the
 * identity diff. `DesktopSessionManager.subscribe` notifies on every `setState`,
 * which `applyTokens` performs on EVERY successful access-token refresh, so the
 * raw stream cannot tell an account switch apart from a routine same-account
 * renewal. The two need opposite handling, a caller re-deriving the difference
 * gets it wrong the way `app.ts` did, and this is where it is known.
 *
 * Shutdown-gated: an auth-state notification can land DURING teardown, after the
 * lanes were stopped, and a re-arm then could restart an upload mid-teardown. The
 * callback no-ops once `isShuttingDown()` is true.
 */
export type AuthSessionLaneKicks = {
  /**
   * ISS-9418: a precondition a GIVEN-UP lane may have been blocked on changed,
   * so buy it one attempt (`AgentSessionSyncService.noteLaneRecoverySignal`).
   *
   * Called on a genuine identity transition ONLY, and the diff that decides that
   * lives here rather than at the call site on purpose. Re-arming on a routine
   * same-account renewal would hand a given-up lane a fresh attempt far more
   * often than the widening window does, which is the 24h ceiling defeated by an
   * unrelated local event: exactly what the give-up's own docstring rules out for
   * an ordinary local write.
   */
  noteLaneRecoverySignal: () => void;
  /**
   * ISS-8610: the OTHER branch of the same identity diff — a routine
   * SAME-account access-token renewal. It is not evidence that a 24h outage
   * ended, so it must never reach {@link noteLaneRecoverySignal}; but it IS the
   * ordinary event that fixes a 401, so the session lane's environmental PACING
   * window ends here (`AgentSessionSyncService.noteCredentialsRefreshed`).
   *
   * Without it, moving 401/403 onto the staged lane gate would have regressed a
   * token-refresh recovery from the old flat 30s to the gate's 5-minute floor
   * and beyond, with no seam able to shorten it: the lane is bounced before it
   * asks for a token, so it cannot mint the very refresh that would release it.
   */
  noteCredentialsRefreshed: () => void;
};

/** The account identity an auth-session change resolves to, or `null` on sign-out. */
export type AuthSessionAccountIdentity = SignedInUserIdentity;

export type AuthSessionLaneRecoveryOptions = {
  laneKicks: AuthSessionLaneKicks;
  /** True once teardown has begun; the re-arm no-ops so it can't restart lanes. */
  isShuttingDown: () => boolean;
  /**
   * ISS-4623 (davetho review) — the account identity as of the auth-session
   * change being reacted to. Used to distinguish a genuine account switch /
   * sign-out (identity changed) from a routine SAME-account token renewal
   * (`applyTokens` re-notifies with an unchanged `{userId, organizationId}`).
   * Returns `null` when signed out.
   */
  getAccountIdentity: () => AuthSessionAccountIdentity | null;
};

export type AuthSessionLaneRecovery = {
  /**
   * React to an auth-session change (sign-in / sign-out / account switch /
   * token renewal) by opening whichever recovery door the identity diff names.
   * No-ops during teardown.
   */
  onAuthSessionChange: () => void;
};

/**
 * Wire the sync lanes' auth-session recovery doors. The returned handle holds no
 * subscription of its own — the caller already owns the auth-state subscription
 * and invokes {@link AuthSessionLaneRecovery.onAuthSessionChange} from it — so
 * there is nothing to dispose.
 */
export function wireAuthSessionLaneRecovery(
  options: AuthSessionLaneRecoveryOptions
): AuthSessionLaneRecovery {
  const { laneKicks, isShuttingDown, getAccountIdentity } = options;
  // ISS-4623 (davetho review) — the account this seam last observed, seeded to
  // the identity at wire time so the very first same-account renewal is
  // recognized as such rather than read as a switch.
  let lastAccountIdentity = getAccountIdentity();
  return {
    onAuthSessionChange: () => {
      if (isShuttingDown()) {
        return;
      }
      const nextIdentity = getAccountIdentity();
      const sameAccount = sameUserIdentity(lastAccountIdentity, nextIdentity);
      lastAccountIdentity = nextIdentity;
      if (sameAccount) {
        // ISS-8610: fresh credentials for the same account. End the session
        // lane's environmental PACING window only — see the seam's contract
        // above for why this may not re-arm a give-up.
        laneKicks.noteCredentialsRefreshed();
        return;
      }
      // ISS-9418: the credentials a lane gave up under may be exactly what
      // changed, so this — and only this — is the sign-in recovery door.
      laneKicks.noteLaneRecoverySignal();
    },
  };
}
