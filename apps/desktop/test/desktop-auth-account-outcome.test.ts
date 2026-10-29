import { OnboardingAccountOutcome } from "@repo/api/src/types/onboarding-analytics.ts";
import { describe, expect, it } from "vitest";
import { DesktopAuthStatus } from "../src/shared/contracts.js";
import { desktopAuthAccountOutcome } from "../src/shared/desktop-auth-account-outcome.js";

/**
 * ISS-10913. The main process composes ONE outcome from the auth status it is
 * settling into plus whether the loopback callback reported a creation.
 */
describe("desktopAuthAccountOutcome", () => {
  it("reports a created account that authenticated", () => {
    expect(
      desktopAuthAccountOutcome(DesktopAuthStatus.Authenticated, true)
    ).toBe(OnboardingAccountOutcome.CreatedSignedIn);
  });

  it("reports a created account whose exchange left no session", () => {
    // The redeem can fail after the account exists; the creation is still the
    // only record of what the auth return did.
    expect(desktopAuthAccountOutcome(DesktopAuthStatus.SignedOut, true)).toBe(
      OnboardingAccountOutcome.CreatedLoggedOut
    );
  });

  it("reports an authenticated state with no creation observed as signed_in", () => {
    expect(
      desktopAuthAccountOutcome(DesktopAuthStatus.Authenticated, false)
    ).toBe(OnboardingAccountOutcome.SignedIn);
  });

  it("reports a settled signed-out state as logged_out", () => {
    expect(desktopAuthAccountOutcome(DesktopAuthStatus.SignedOut, false)).toBe(
      OnboardingAccountOutcome.LoggedOut
    );
  });

  it("treats cleared-credential refresh failure as a settled logged_out, not an unknown", () => {
    expect(
      desktopAuthAccountOutcome(DesktopAuthStatus.RefreshFailed, false)
    ).toBe(OnboardingAccountOutcome.LoggedOut);
  });

  it.each([
    DesktopAuthStatus.Loading,
    DesktopAuthStatus.OpeningBrowser,
    DesktopAuthStatus.AwaitingRedirect,
    DesktopAuthStatus.Exchanging,
  ])("reports %s as unknown, because no auth return has settled", (status) => {
    // Answering `logged_out` here would state an outcome for a browser round
    // trip that is still open.
    expect(desktopAuthAccountOutcome(status, false)).toBe(
      OnboardingAccountOutcome.Unknown
    );
    expect(desktopAuthAccountOutcome(status, true)).toBe(
      OnboardingAccountOutcome.Unknown
    );
  });
});
