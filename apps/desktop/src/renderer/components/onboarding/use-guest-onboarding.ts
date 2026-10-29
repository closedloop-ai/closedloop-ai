import {
  WORKSPACE_MENU_ENTRY_LABEL,
  WorkspaceMenuEntryId,
} from "@repo/api/src/types/workspace-menu";
import { DesktopAuthStatus } from "../../../shared/contracts";
import { useDesktopAuth } from "../../shared-agent-sessions/desktop-auth-provider";

export type GuestOnboardingState = {
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
};

/**
 * ISS-5112 — the fact every guest-mode decision on the dashboard turns on.
 *
 * ISS-7995 retired the `guest-onboarding` Labs flag: guest mode is the only
 * first-run path now, so auth status is the whole state. The hook survives the
 * flag because it is where "who counts as a guest" is defined, and every
 * guest-mode entry point reads that answer through it.
 */
export function useGuestOnboarding(): GuestOnboardingState {
  const { state } = useDesktopAuth();
  return { authStatus: state.status };
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
 * sign up for — and neither do the three states in between, which a plain
 * not-authenticated test would have swept into guest mode: a sign-in already in
 * flight would get a second account prompt on top of it, and a lapsed session
 * would tell a returning user to create the account they already have.
 */
export function canOfferAccount(guest: GuestOnboardingState): boolean {
  return guest.authStatus === DesktopAuthStatus.SignedOut;
}

/**
 * What the tour's last button says, derived from the SAME answer that decides
 * what pressing it does — whether `useRequestGuestAccount` handed the page an
 * ask — so the label and the behavior cannot drift apart. `undefined` leaves
 * the tour on its own "Done", which is the truth whenever finishing the tour
 * only closes the tour.
 */
export function tourCompleteLabel(
  canRequestAccount: boolean
): string | undefined {
  if (canRequestAccount) {
    return WORKSPACE_MENU_ENTRY_LABEL[WorkspaceMenuEntryId.CreateAccount];
  }
  return undefined;
}
