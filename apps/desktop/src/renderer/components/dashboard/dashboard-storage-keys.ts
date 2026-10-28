/** LocalStorage flag set once the one-time dashboard reveal has completed. */
export const dashboardOnboardedStorageKey = "cl-desktop-dashboard-onboarded";

/** LocalStorage flag set once the dashboard guided tour has been seen. */
export const dashboardTourSeenStorageKey = "cl-desktop-dashboard-tour-seen";

/**
 * LocalStorage flag set once the post-auth invite spotlight has been ANSWERED
 * for one organization — by inviting, by "Maybe later", or by dismissing the
 * pop-up any other way (ISS-5489, PLN-1694 M2).
 *
 * Keyed BY ORG, unlike the two flags above, because the nudge itself is
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
 * LocalStorage record of a SIGNED-OUT guest's guided onboarding run (ISS-10195
 * follow-up).
 *
 * Third of the first-run keys and kept beside them deliberately: "what has
 * this install already been shown" is one question, and splitting its answers
 * across files is how one of them gets missed.
 *
 * Unlike its two neighbours this key does not hold a marker — it holds the
 * run's serialized state and revision, because a guest's run has a POSITION and
 * not merely a have-they-seen-it bit. A guest who quit at Session Discovery
 * returns to Session Discovery, the same way an account's run resumes from its
 * `OnboardingAttempt` row. The signed-in equivalent is that server row; this is
 * the local authority for the reader who has no account to own one.
 */
export const desktopGuestGuidedOnboardingStorageKey =
  "cl-desktop-guest-guided-onboarding";

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
    return getLocalStorage()?.getItem(key) === DASHBOARD_FLAG_SET;
  } catch {
    return false;
  }
}

export function writeFlag(key: string): void {
  try {
    getLocalStorage()?.setItem(key, DASHBOARD_FLAG_SET);
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

/**
 * The one value a set flag is stored as, so the writer and every reader of these
 * keys cannot drift apart about what a set flag looks like on disk. ISS-9728's
 * validated guest read parses against this rather than restating the literal.
 */
export const DASHBOARD_FLAG_SET = "1";

/**
 * The stored value for `key`, unexamined — `undefined` when this store cannot
 * answer at all.
 *
 * For a caller that must tell an ABSENT record from an unreadable one and from
 * a set one, which {@link readFlag}'s boolean cannot (ISS-9728). It routes
 * through the same {@link getLocalStorage} guard rather than reaching for the
 * global itself, so there is still exactly one place that decides whether this
 * install has a usable store.
 */
export function readRawFlag(key: string): unknown {
  try {
    return getLocalStorage()?.getItem(key);
  } catch {
    return;
  }
}

/**
 * Store `value` verbatim under `key`.
 *
 * The twin of {@link readRawFlag}, for the one key here that holds a record
 * rather than a marker ({@link desktopGuestGuidedOnboardingStorageKey}).
 * {@link writeFlag} cannot serve it: that function writes
 * {@link DASHBOARD_FLAG_SET} and ignores any value, which is correct for a
 * marker and silently lossy for a record.
 *
 * Routes through the same {@link getLocalStorage} guard, so there is still one
 * place that decides whether this install has a usable store, and swallows a
 * throwing store for the reason the accessors above do — a guest whose store is
 * full or blocked keeps a working renderer and loses only the resumption.
 */
export function writeRawFlag(key: string, value: string): void {
  try {
    getLocalStorage()?.setItem(key, value);
  } catch {
    // Nothing to do and nothing to tell the user: losing the record costs this
    // guest a resumed position, never correctness, and no client-side logging
    // (repo policy).
  }
}

/**
 * Drop `key` entirely.
 *
 * Removal rather than writing an empty or "done" marker, because every reader
 * of these keys folds an ABSENT value to "not yet" — see
 * {@link desktopGuestGuidedOnboardingStorageKey}. A sentinel meaning "handed
 * off" would be a second vocabulary for the same slot, and the first reader to
 * miss it would read it as a record.
 *
 * Routes through the same {@link getLocalStorage} guard and swallows a throwing
 * store for the reason its siblings do.
 */
export function removeRawFlag(key: string): void {
  try {
    getLocalStorage()?.removeItem(key);
  } catch {
    // Nothing to do and nothing to tell the user (repo policy on client logs).
  }
}
