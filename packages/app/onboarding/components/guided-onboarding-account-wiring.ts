import type { GuidedOnboardingSnapshot } from "@repo/api/src/types/onboarding-guided";
import { AccountStatus } from "@repo/api/src/types/onboarding-phase";
import type { AccountEstablishedOnboardingEvent } from "../lib/guided-onboarding-events";
import type { AuthMethod } from "./auth-methods";
import type { OnboardingAccount } from "./guided-onboarding-data";
import type { GuidedOnboardingDialogProps } from "./guided-onboarding-types";

/** The host's handler for a method picked on the Account step. */
export type AccountSelectHandler = (input: {
  email?: string;
  event: AccountEstablishedOnboardingEvent;
  method: AuthMethod;
}) => void;

/**
 * Whether this reader ALREADY HAS an account: the union of the run's own record
 * and this host's live session, not the record alone.
 *
 * ISS-11256 made the SESSION arm the compatibility half rather than the live
 * one. No in-repo producer composes `Skipped` for a reader WITH an account any
 * more: `buildServerContext` reports `Established` unconditionally
 * (`snapshot-service.ts`), the desktop guest run composes `Skipped` only for a
 * signed-out reader who has no account and no session to pair it with
 * (`guest-onboarding-context.ts`), and the handoff reports
 * `snapshot: null` while in flight and the server's own measured context once
 * held. A null snapshot does not exercise this arm either — `currentState` is
 * then `null`, so the dialog shows its restoring body and no Account step
 * renders.
 *
 * What still reaches it is a SKEWED PRODUCER: a client built from this commit
 * reading an API deploy that has not landed ISS-11256 still derives `Skipped`
 * from the skip marker. Reading the record alone there puts the create-account
 * methods in front of a signed-in reader — on Web, three enabled controls that
 * host has no handler for at all. That is the version-skew surface the repo
 * carves out of the unreachable-code rule, so the arm stays and its test pins
 * it against that payload.
 */
export function readerHasAccount(
  snapshot: GuidedOnboardingSnapshot | null,
  account: OnboardingAccount
): boolean {
  return (
    snapshot?.context.accountStatus === AccountStatus.Established ||
    account.status === "signed-in"
  );
}

/**
 * The Account step's per-method callbacks, or none of them.
 *
 * ISS-11256: absent, never a no-op. `dispatchAccountMethod` routes a chosen
 * method by testing these for PRESENCE and falls back to `onComplete` when one
 * is missing, so an always-supplied callback that folded to `undefined` answered
 * that test affirmatively and shipped three enabled buttons that did nothing.
 */
export function buildAccountMethodHandlers(
  onAccountSelect: AccountSelectHandler | undefined
): Pick<
  GuidedOnboardingDialogProps,
  "onContinueWithEmail" | "onContinueWithGitHub" | "onContinueWithGoogle"
> {
  if (!onAccountSelect) {
    return {};
  }
  return {
    onContinueWithEmail: (email, event) =>
      onAccountSelect({ email, event, method: "email" }),
    onContinueWithGitHub: (event) =>
      onAccountSelect({ event, method: "github" }),
    onContinueWithGoogle: (event) =>
      onAccountSelect({ event, method: "google" }),
  };
}
