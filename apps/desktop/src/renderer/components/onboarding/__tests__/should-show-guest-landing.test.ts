/**
 * ISS-5112 (PLN-1600 Step F): which launches get the first-run landing.
 *
 * Two predicates because the decision is made in two places for a structural
 * reason — `isGuestLandingArmed` answers "is this install a candidate" without
 * touching auth, so a flag-off launch never mounts the hook that requires a
 * `DesktopAuthProvider`; `shouldShowGuestLanding` answers "is this person a
 * guest right now" once it is. Both are pure, so every combination is cheap to
 * state here and the mounted suite next door can spend its time on the wiring.
 */

import { describe, expect, it } from "vitest";
import { DesktopAuthStatus } from "../../../../shared/contracts";
import {
  isGuestLandingArmed,
  shouldShowGuestLanding,
} from "../guest-landing-gate";
import type { GuestOnboardingState } from "../use-guest-onboarding";

function guestState(
  overrides: Partial<GuestOnboardingState> = {}
): GuestOnboardingState {
  return {
    enabled: true,
    authStatus: DesktopAuthStatus.SignedOut,
    resolved: true,
    ...overrides,
  };
}

describe("isGuestLandingArmed", () => {
  it("arms on a first run with the flag resolved and on", () => {
    expect(
      isGuestLandingArmed({
        flagEnabled: true,
        flagsResolved: true,
        firstRun: true,
      })
    ).toBe(true);
  });

  it("stays disarmed with the flag off", () => {
    // The product default. A gate that accidentally always armed would pass a
    // flag-on-only suite, so this case is not redundant with the one above.
    expect(
      isGuestLandingArmed({
        flagEnabled: false,
        flagsResolved: true,
        firstRun: true,
      })
    ).toBe(false);
  });

  it("stays disarmed while the flag snapshot is unresolved", () => {
    // ISS-5037: an unresolved snapshot reads every flag as its registry default,
    // so "we do not know yet" must not raise a full-window takeover that then
    // retracts.
    expect(
      isGuestLandingArmed({
        flagEnabled: true,
        flagsResolved: false,
        firstRun: true,
      })
    ).toBe(false);
  });

  it("stays disarmed once the install has answered or already launched", () => {
    // The upgrade case: every existing user is `firstRun: false` by virtue of
    // the onboarded flag, so switching the flag on cannot greet them with a
    // first-run pitch.
    expect(
      isGuestLandingArmed({
        flagEnabled: true,
        flagsResolved: true,
        firstRun: false,
      })
    ).toBe(false);
  });
});

describe("shouldShowGuestLanding", () => {
  it("shows for a settled signed-out device", () => {
    expect(
      shouldShowGuestLanding({ guest: guestState(), signingIn: false })
    ).toBe(true);
  });

  it("holds through the auth states a sign-in from the landing passes through", () => {
    // The whole reason `signingIn` exists: auth leaves `signed_out` as soon as
    // the browser opens, so `canOfferAccount` alone would drop the takeover
    // mid-flow. Each of these is a state the flow genuinely reaches.
    for (const authStatus of [
      DesktopAuthStatus.OpeningBrowser,
      DesktopAuthStatus.AwaitingRedirect,
      DesktopAuthStatus.Exchanging,
    ]) {
      expect(
        shouldShowGuestLanding({
          guest: guestState({ authStatus }),
          signingIn: true,
        })
      ).toBe(true);
    }
  });

  it.each([
    DesktopAuthStatus.Authenticated,
    DesktopAuthStatus.RefreshFailed,
    DesktopAuthStatus.OpeningBrowser,
    DesktopAuthStatus.Loading,
  ])("stays hidden for a %s device that did not start here", (authStatus) => {
    // `refresh_failed` in particular is an EXISTING user whose session lapsed —
    // the wrong person to greet with a first-run pitch — and an in-flight
    // sign-in that began in Settings belongs to a run already under way.
    expect(
      shouldShowGuestLanding({
        guest: guestState({ authStatus }),
        signingIn: false,
      })
    ).toBe(false);
  });

  it("defers to the shared guest test rather than re-deriving it", () => {
    // `canOfferAccount` is the one definition of "a guest we may offer an
    // account to", shared with the tour, the scope toggle, the invite item and
    // the topbar. A disabled flag reaching here at all would mean the arming
    // check was bypassed, and this still refuses.
    expect(
      shouldShowGuestLanding({
        guest: guestState({ enabled: false }),
        signingIn: false,
      })
    ).toBe(false);
  });
});
