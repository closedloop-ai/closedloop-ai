/** LocalStorage flag set once the one-time dashboard reveal has completed. */
export const dashboardOnboardedStorageKey = "cl-desktop-dashboard-onboarded";

/** LocalStorage flag set once the dashboard guided tour has been seen. */
export const dashboardTourSeenStorageKey = "cl-desktop-dashboard-tour-seen";

/**
 * LocalStorage flag set once the first-run landing has been ANSWERED — by
 * entering as a guest or by signing in (ISS-5112, PLN-1600 Step F).
 *
 * Third of the three first-run keys and kept beside them deliberately: "what has
 * this install already been shown" is one question, and splitting its answers
 * across files is how one of them gets missed. The landing gate reads
 * `dashboardOnboardedStorageKey` too — an install whose first-launch reveal has
 * already played is not a first run, whether or not this key was ever written,
 * which is what keeps the landing off every EXISTING install when the flag is
 * turned on.
 */
export const desktopLandingSeenStorageKey = "cl-desktop-landing-seen";

/**
 * LocalStorage flag set once the post-auth invite spotlight has been ANSWERED
 * for one organization — by inviting, by "Maybe later", or by dismissing the
 * pop-up any other way (ISS-5489, PLN-1694 M2).
 *
 * Keyed BY ORG, unlike the three flags above, because the nudge itself is
 * per-org: "invite your team" means a different team in each one, and an answer
 * given for the org you were in last month is not an answer for the one you
 * joined today. Device scope comes free — `localStorage` is this install's.
 *
 * Kept here with the other "what has this install already been shown" flags on
 * purpose: splitting those answers across files is how one of them gets missed.
 * It is renderer-local rather than a `settings-store` key for the same reason
 * the first-run flags are — no main-process consumer reads it, and a nudge that
 * silently re-appears after a profile wipe costs one dismissal, not correctness.
 */
export function inviteSpotlightDismissedStorageKey(
  organizationId: string
): string {
  return `cl-desktop-invite-spotlight-dismissed:${organizationId}`;
}

/**
 * Both accessors swallow a throwing store, not just an absent one.
 *
 * `getLocalStorage` already guarded the PROPERTY access, but the read and write
 * themselves sat outside that guard — and a present `localStorage` whose
 * `getItem` throws is a real state (Safari private browsing, a blocked or
 * quota-exhausted store, a test that stubs the failure). The intent was always
 * "first-run flags degrade to unknown rather than take the app down"; this
 * finishes it. Unknown reads as `false`, so the worst case is a first-run
 * affordance shown once more than it should be — never a renderer that fails to
 * mount.
 */
export function readFlag(key: string): boolean {
  try {
    return getLocalStorage()?.getItem(key) === "1";
  } catch {
    return false;
  }
}

export function writeFlag(key: string): void {
  try {
    getLocalStorage()?.setItem(key, "1");
  } catch {
    // Nothing to do and nothing to tell the user: the flag is a convenience, and
    // no client-side logging (repo policy).
  }
}

function getLocalStorage(): Storage | null {
  try {
    const storage = globalThis.localStorage;
    if (
      !storage ||
      typeof storage.getItem !== "function" ||
      typeof storage.setItem !== "function"
    ) {
      return null;
    }
    return storage;
  } catch {
    return null;
  }
}
