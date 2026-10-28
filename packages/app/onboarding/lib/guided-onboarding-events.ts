import {
  OnboardingEvent,
  type OnboardingEventInput,
} from "@repo/api/src/types/onboarding-events";
import { AccountProvider } from "@repo/api/src/types/onboarding-phase";
import type { AuthMethod } from "../components/auth-methods";

export type AccountEstablishedOnboardingEvent = Extract<
  OnboardingEventInput,
  { type: typeof OnboardingEvent.AccountEstablished }
>;

export type OrganizationReadyOnboardingEvent = Extract<
  OnboardingEventInput,
  {
    type: typeof OnboardingEvent.OrganizationReady;
  }
>;

const ACCOUNT_PROVIDER_BY_AUTH_METHOD: Record<AuthMethod, AccountProvider> = {
  email: AccountProvider.Email,
  github: AccountProvider.GitHub,
  google: AccountProvider.Google,
};

/** Build the typed transition event for an account-phase action. */
export function createAccountEstablishedEvent(
  method: AuthMethod
): AccountEstablishedOnboardingEvent {
  return {
    provider: ACCOUNT_PROVIDER_BY_AUTH_METHOD[method],
    type: OnboardingEvent.AccountEstablished,
  };
}

/** Build the typed transition event for organization creation or selection. */
export function createOrganizationReadyEvent(): OrganizationReadyOnboardingEvent {
  return { type: OnboardingEvent.OrganizationReady };
}

/**
 * The account-established event for a run whose provider was MEASURED rather
 * than chosen from a button — the snapshot's `context.accountProvider`, which
 * the server resolves from the account's linked Clerk OAuth providers.
 *
 * `null` means no OAuth provider is linked, and {@link AccountProvider.Email}
 * is the measured answer to that rather than a guess: Clerk's external-account
 * list is the whole source of OAuth evidence, so an empty one is an account
 * established by email. The fallback is stated ONCE here because two callers
 * need it — the host's own Continue on an already-established account, and the
 * desktop guest handoff — and a second copy is how they drift.
 */
export function createAccountEstablishedEventForProvider(
  provider: AccountProvider | null | undefined
): AccountEstablishedOnboardingEvent {
  return {
    provider: provider ?? AccountProvider.Email,
    type: OnboardingEvent.AccountEstablished,
  };
}
