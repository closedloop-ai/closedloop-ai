import type { ServerOnboardingContext } from "@repo/api/src/types/onboarding-guided";
import {
  AccountStatus,
  KnownFlag,
  type OnboardingContext,
  OnboardingHost,
  OrganizationMembership,
} from "@repo/api/src/types/onboarding-phase";

/**
 * What is true of a signed-out desktop device, stated once for every guest
 * reader: the guided run (`useGuestGuidedOnboardingRun`) and the Getting
 * started card (`GuestGettingStartedCard`).
 *
 * The guard inputs are each MEASURED rather than defaulted. The snapshot
 * service refuses to default any of these for an account, because "a `false`
 * here is indistinguishable from a measured negative and each one either grants
 * or denies a gate". The same standard applies to a guest, and every field
 * below is genuinely knowable without a server:
 *
 * - `accountStatus` / `accountProvider`: there is no account. `Skipped` is what
 *   makes the account step outstanding (`isStepOutstanding`), which is the
 *   honest reading of a device running in guest mode, and it is what lets a
 *   guest run resume that step.
 * - `membership`: a guest who signs up is the first member of the organization
 *   that signup creates, not a member of organizations they are not in.
 * - `githubConnected`: a GitHub grant hangs off an account, so a reader with no
 *   account has none. Measured, not assumed absent.
 * - `desktopAppDownloaded`: this code is EXECUTING in the desktop app. The
 *   server can only infer this from a registered compute target; here it is
 *   directly observable and unambiguously true.
 * - `organizationHasSyncedSessionData`: `Unknown`, the one field whose producer
 *   is allowed to carry an unknown all the way to the guard. There is no
 *   organization to have synced anything, so claiming `false` would assert a
 *   measurement nobody took.
 * - `teamInvited`: no organization means no invitations could have been sent.
 * - `tourCompleted`: read from this install's own tour record, which ISS-9728
 *   made the only authority for a guest.
 */
export function guestServerOnboardingContext(
  tourCompleted: boolean
): ServerOnboardingContext {
  return {
    accountProvider: null,
    accountStatus: AccountStatus.Skipped,
    desktopAppDownloaded: true,
    githubConnected: false,
    membership: OrganizationMembership.FirstUser,
    organizationHasSyncedSessionData: KnownFlag.Unknown,
    teamInvited: false,
    tourCompleted,
  };
}

/**
 * The full context the guest Getting started card projects its checklist from.
 * The client-side fields are known outright for a signed-out device too: no
 * recorded sync consent, and nothing for the card's two predicates to read from
 * the tour or the analyzer.
 */
export const GUEST_ONBOARDING_CONTEXT: OnboardingContext = {
  ...guestServerOnboardingContext(false),
  analysisStarted: true,
  host: OnboardingHost.Desktop,
  // ISS-11090 added this to `OnboardingContext`. `Unknown`, not `No`, because
  // the field's own contract says a signed-out session is `Unknown` and only
  // `No` may create an organization — which a device with no account must not
  // be authorised to do. `organizationActiveFlag` returns exactly this for a
  // null `userId`, so the guest card reads the canonical answer rather than
  // deriving a second one. No step moves either way: the two predicates the
  // card calls live in `onboarding-completion.ts`, which does not read it.
  organizationActive: KnownFlag.Unknown,
  syncConsentRecorded: KnownFlag.Unknown,
};
