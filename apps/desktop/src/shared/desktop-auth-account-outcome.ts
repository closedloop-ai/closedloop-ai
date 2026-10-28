import { OnboardingAccountOutcome } from "@repo/api/src/types/onboarding-analytics.ts";
import { DesktopAuthStatus } from "./contracts.js";

/**
 * Compose the evaluated {@link OnboardingAccountOutcome} the renderer auth
 * state carries (ISS-10913), from the two facts the main process actually
 * holds: the auth status it is settling into, and whether the loopback
 * callback that produced it reported an account CREATION.
 *
 * Two facts, not one, because they answer different questions and either can
 * be true alone — a redeem that fails after a brand-new account was created
 * leaves `created` with no session behind it. The desktop door's framing
 * (`DesktopSignInFraming`) is never an input: it records which door the person
 * chose, and an existing account can walk through the sign-up door.
 */

/** What a status says about whether an account is established right now. */
const AccountSettlement = {
  /** The status is a settled answer: an account is established. */
  Authenticated: "authenticated",
  /** The status is a settled answer: no account is established. */
  Unauthenticated: "unauthenticated",
  /** A run is still in flight, so the status answers nothing yet. */
  Undetermined: "undetermined",
} as const;
type AccountSettlement =
  (typeof AccountSettlement)[keyof typeof AccountSettlement];

/**
 * Exhaustive over {@link DesktopAuthStatus}: a new status fails typecheck here
 * until it declares whether it is a settled answer about the account. The
 * transient sign-in statuses are deliberately undetermined — reporting
 * `logged_out` while a browser round trip is still open would state an outcome
 * for a run that has not returned.
 */
const SETTLEMENT_BY_STATUS: Record<DesktopAuthStatus, AccountSettlement> = {
  [DesktopAuthStatus.Loading]: AccountSettlement.Undetermined,
  [DesktopAuthStatus.OpeningBrowser]: AccountSettlement.Undetermined,
  [DesktopAuthStatus.AwaitingRedirect]: AccountSettlement.Undetermined,
  [DesktopAuthStatus.Exchanging]: AccountSettlement.Undetermined,
  [DesktopAuthStatus.Authenticated]: AccountSettlement.Authenticated,
  [DesktopAuthStatus.SignedOut]: AccountSettlement.Unauthenticated,
  // Stored credentials were found invalid and cleared: this IS a settled
  // answer that no account is established, not an unknown.
  [DesktopAuthStatus.RefreshFailed]: AccountSettlement.Unauthenticated,
};

/**
 * The outcome for a status/creation pair.
 *
 * `accountCreated` is only ever true for the run whose callback carried the
 * marker, so a restored session or an ordinary resting state reports the
 * session fact alone. That is the honest reading: an absent marker is "no
 * creation observed", which is not evidence of an existing account and is not
 * a reason to withhold the session state the process can plainly see.
 */
export function desktopAuthAccountOutcome(
  status: DesktopAuthStatus,
  accountCreated: boolean
): OnboardingAccountOutcome {
  const settlement = SETTLEMENT_BY_STATUS[status];
  if (settlement === AccountSettlement.Authenticated) {
    return accountCreated
      ? OnboardingAccountOutcome.CreatedSignedIn
      : OnboardingAccountOutcome.SignedIn;
  }
  if (settlement === AccountSettlement.Unauthenticated) {
    return accountCreated
      ? OnboardingAccountOutcome.CreatedLoggedOut
      : OnboardingAccountOutcome.LoggedOut;
  }
  return OnboardingAccountOutcome.Unknown;
}
