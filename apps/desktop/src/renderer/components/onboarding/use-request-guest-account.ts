import { OnboardingEvent } from "@repo/api/src/types/onboarding-events";
import { PendingOnboardingStep } from "@repo/api/src/types/onboarding-phase";
import { useCallback } from "react";
import {
  getGuidedOnboardingRunOverride,
  useGuidedOnboardingRunOverride,
} from "./guided-onboarding-run-override-store";
import { canOfferAccount, useGuestOnboarding } from "./use-guest-onboarding";

/**
 * ISS-11480 (PLN-2126 Step 5) — what every guest "Create account" entry point
 * presses: reopen the guided onboarding at its Account step, the prototype's
 * `openAccountSetup`, by posting `resume_pending_step(create_account)` to the
 * guest run the dialog host publishes.
 *
 * `undefined` when there is nothing to press: the reader is not a settled guest
 * (`canOfferAccount`), or no run with a snapshot is published — which for a
 * settled guest happens only when local storage cannot answer. Callers render
 * their control only when this is defined, so an entry point is never an
 * enabled control that does nothing.
 *
 * The run is re-read at press time rather than captured at render, so the
 * resume is posted against the snapshot the modal is currently rendering.
 */
export function useRequestGuestAccount(): (() => void) | undefined {
  const guest = useGuestOnboarding();
  const run = useGuidedOnboardingRunOverride();
  const request = useCallback(() => {
    const current = getGuidedOnboardingRunOverride();
    if (!current?.snapshot) {
      return;
    }
    current.postTransition(current.snapshot, {
      step: PendingOnboardingStep.CreateAccount,
      type: OnboardingEvent.ResumePendingStep,
    });
  }, []);
  // For a settled guest the only no-run case is localStorage unable to answer.
  // That guest is not stranded: Settings → Account keeps its own sign-in.
  if (!(canOfferAccount(guest) && run?.snapshot)) {
    return;
  }
  return request;
}
