import { useFeatureFlagEnabled } from "@repo/app/shared/feature-flags/use-feature-flag-enabled";
import { DesktopAuthStatus } from "../../../shared/contracts";
import { DESKTOP_GUEST_ONBOARDING_FEATURE_FLAG_KEY } from "../../../shared/feature-flags";
import { useDesktopFeatureFlagsResolved } from "../../feature-flags/desktop-feature-flag-provider";
import { useDesktopAuth } from "../../shared-agent-sessions/desktop-auth-provider";

export type GuestOnboardingState = {
  /** The `guest-onboarding` Labs flag, resolved. Never true before the snapshot lands. */
  enabled: boolean;
  /**
   * The live desktop auth status, carried whole rather than flattened to a
   * boolean. The states between signed-out and authenticated are NEITHER, and
   * each is wrong to treat as a guest for its own reason: a sign-in in flight
   * (`opening_browser` / `awaiting_redirect` / `exchanging`) belongs to a run
   * already under way — one started from Settings or the session-expired banner
   * survives navigation here — and `refresh_failed` is an EXISTING user whose
   * session lapsed, who must be asked to sign back in, not to create an account.
   */
  authStatus: DesktopAuthStatus;
  /**
   * Whether the desktop flag snapshot has landed (ISS-5037). Exposed separately
   * from `enabled` because "we do not know yet" and "we know it is off" are
   * different decisions for a caller that mounts something irreversible:
   * `DashboardPage` withholds its blocking modal while unresolved rather than
   * flashing and retracting it, which `enabled` alone cannot express.
   */
  resolved: boolean;
};

/**
 * ISS-5112 — the two facts every guest-mode decision on the dashboard turns on.
 *
 * An UNRESOLVED desktop flag snapshot reads every flag as its registry default,
 * which for a default-off flag is indistinguishable from "the user turned it
 * off" — so it counts as off here, the same posture
 * `shouldShowOnboardingOverlay` takes in `DashboardPage` (ISS-5037).
 */
export function useGuestOnboarding(): GuestOnboardingState {
  const flagEnabled = useFeatureFlagEnabled(
    DESKTOP_GUEST_ONBOARDING_FEATURE_FLAG_KEY
  );
  const flagsResolved = useDesktopFeatureFlagsResolved();
  const { state } = useDesktopAuth();
  return {
    enabled: flagsResolved && flagEnabled,
    authStatus: state.status,
    resolved: flagsResolved,
  };
}

/**
 * Whether this device is a guest who can be offered an account at all.
 *
 * The same settled-signed-out test every guest-mode entry point needs — the
 * tour's ending, the dashboard's organization scope, the sidebar's invite item
 * and the topbar's sign-up button. Shared so a future change to what counts as
 * "a guest" cannot land on one of them and miss the other three.
 *
 * Only a SETTLED signed-out device qualifies. A signed-in replay has nothing to
 * sign up for and a flag-off launch keeps the do-nothing "done" the tour has
 * always had — but so do the three states in between, which a plain
 * not-authenticated test would have swept into guest mode: a sign-in already in
 * flight would get a second account prompt on top of it, and a lapsed session
 * would tell a returning user to create the account they already have.
 */
export function canOfferAccount(guest: GuestOnboardingState): boolean {
  return guest.enabled && guest.authStatus === DesktopAuthStatus.SignedOut;
}

/**
 * What the tour's last button says, derived from the SAME predicate that
 * decides what pressing it does — so the label and the behavior cannot drift
 * apart. `undefined` leaves the tour on its own "Done", which is the truth
 * whenever finishing the tour only closes the tour.
 */
export function tourCompleteLabel(
  guest: GuestOnboardingState
): string | undefined {
  if (canOfferAccount(guest)) {
    return TOUR_CREATE_ACCOUNT_LABEL;
  }
  return undefined;
}

const TOUR_CREATE_ACCOUNT_LABEL = "Create account";
