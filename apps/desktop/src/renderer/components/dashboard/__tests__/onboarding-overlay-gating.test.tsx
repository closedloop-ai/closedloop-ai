import { describe, expect, it } from "vitest";
import { shouldShowOnboardingOverlay } from "../DashboardPage";

// PRD-532 (M4): the first-launch onboarding overlay is layered over the
// Dashboard when the device is not yet signed in.
// ISS-5112: the `guest-onboarding` Labs flag replaces that overlay with a
// reachable guest Dashboard, so the overlay is now also gated on the flag being
// off AND on the flag snapshot having actually arrived.

const settled = { flagsResolved: true, guestOnboardingEnabled: false };

describe("shouldShowOnboardingOverlay", () => {
  it("renders when the device is signed out", () => {
    expect(
      shouldShowOnboardingOverlay({
        ...settled,
        authStatus: "signed_out",
        dismissed: false,
      })
    ).toBe(true);
    expect(
      shouldShowOnboardingOverlay({
        ...settled,
        authStatus: "refresh_failed",
        dismissed: false,
      })
    ).toBe(true);
  });

  it("does not render for an already-authenticated device", () => {
    expect(
      shouldShowOnboardingOverlay({
        ...settled,
        authStatus: "authenticated",
        dismissed: false,
      })
    ).toBe(false);
  });

  it("does not flash while the auth state is still loading", () => {
    expect(
      shouldShowOnboardingOverlay({
        ...settled,
        authStatus: "loading",
        dismissed: false,
      })
    ).toBe(false);
  });

  it("does not re-render once dismissed this session", () => {
    expect(
      shouldShowOnboardingOverlay({
        ...settled,
        authStatus: "signed_out",
        dismissed: true,
      })
    ).toBe(false);
  });

  // --- ISS-5112 -----------------------------------------------------------

  it("withholds the overlay until the flag snapshot arrives", () => {
    // An unresolved snapshot reads as `false`, which would otherwise mean
    // "guest mode off" and mount the blocking modal — then retract it a tick
    // later. Signed-out is the case that would actually flash.
    expect(
      shouldShowOnboardingOverlay({
        authStatus: "signed_out",
        dismissed: false,
        flagsResolved: false,
        guestOnboardingEnabled: false,
      })
    ).toBe(false);
  });

  it("does not block the Dashboard when guest onboarding is enabled", () => {
    expect(
      shouldShowOnboardingOverlay({
        authStatus: "signed_out",
        dismissed: false,
        flagsResolved: true,
        guestOnboardingEnabled: true,
      })
    ).toBe(false);
  });

  it("still blocks a signed-out device when guest onboarding is off", () => {
    // The flag-off path must stay identical to pre-ISS-5112 behavior. Asserts
    // the default branch, not only the new one, so a gate that accidentally
    // always returns false fails here.
    expect(
      shouldShowOnboardingOverlay({
        authStatus: "signed_out",
        dismissed: false,
        flagsResolved: true,
        guestOnboardingEnabled: false,
      })
    ).toBe(true);
  });
});
