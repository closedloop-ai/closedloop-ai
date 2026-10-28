import { Button } from "@closedloop-ai/design-system/components/ui/button";
import {
  listApplicableOnboardingSteps,
  listPendingOnboardingSteps,
} from "@repo/api/src/types/onboarding-completion";
import {
  WORKSPACE_MENU_ENTRY_LABEL,
  WorkspaceMenuEntryId,
} from "@repo/api/src/types/workspace-menu";
import {
  GETTING_STARTED_ACTION_CLASS_NAME,
  GettingStartedCardShell,
  GettingStartedStepAction,
  listActionableOnboardingSteps,
} from "@repo/app/onboarding/components/getting-started-card-shell";
import { GUEST_ONBOARDING_CONTEXT } from "./guest-onboarding-context";
import { useRequestGuestAccount } from "./use-request-guest-account";
import { useRequestGuestSignIn } from "./use-request-guest-sign-in";

/**
 * ISS-10942 — the Getting started module a signed-out guest gets.
 *
 * {@link GuidedGettingStartedCard} draws a SERVER-owned run, and its snapshot
 * query is disabled while there is no Clerk identity, so a guest never had a
 * checklist at all — which is why the account offer used to live on the
 * dashboard title row instead. This is not a second onboarding model: the steps,
 * their host applicability and their outstanding-ness come from the same
 * `onboarding-completion.ts` predicates the server-owned card reads. Only the
 * CONTEXT is local, and for a signed-out device every field in it is known
 * outright rather than measured.
 *
 * Every step it can name needs the account first, so whichever one leads, the
 * press reopens the guided onboarding at its Account step (ISS-11480).
 */
export function GuestGettingStartedCard({
  className,
}: {
  readonly className?: string;
} = {}) {
  const requestAccount = useRequestGuestAccount();
  const requestSignIn = useRequestGuestSignIn();

  if (!requestAccount) {
    return null;
  }

  // Settled, not measured: every field of a signed-out device's context is known
  // outright (see {@link GUEST_ONBOARDING_CONTEXT}), so there is no unresolved
  // consent read to withhold the sync row for. Since ISS-11249 that read is the
  // whole condition — the step is answered inside the onboarding modal, so it no
  // longer needs a Connected Devices route a guest does not have.
  const applicable = listActionableOnboardingSteps(
    listApplicableOnboardingSteps(GUEST_ONBOARDING_CONTEXT),
    true
  );
  const pending = listActionableOnboardingSteps(
    listPendingOnboardingSteps(GUEST_ONBOARDING_CONTEXT),
    true
  );
  const step = pending[0];
  if (step === undefined || applicable.length === 0) {
    return null;
  }

  return (
    <GettingStartedCardShell
      action={
        <>
          <GettingStartedStepAction onClick={requestAccount} step={step} />
          {requestSignIn ? (
            <Button
              className={GETTING_STARTED_ACTION_CLASS_NAME}
              onClick={requestSignIn}
              size="sm"
              type="button"
              variant="ghost"
            >
              {WORKSPACE_MENU_ENTRY_LABEL[WorkspaceMenuEntryId.SignIn]}
            </Button>
          ) : null}
        </>
      }
      className={className}
      completed={applicable.length - pending.length}
      total={applicable.length}
    />
  );
}
