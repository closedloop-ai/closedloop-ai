import { OnboardingPhase } from "@repo/api/src/types/onboarding-phase";
import type { WizardPhase } from "@repo/app/onboarding/components/guided-onboarding-types"; // Cross-slice: preview shell runs the real onboarding flow (ISS-12938).
import { isWizardPhase } from "@repo/app/onboarding/components/guided-onboarding-types"; // Cross-slice: preview shell runs the real onboarding flow (ISS-12938).
import type { FtuePhase } from "./ftue-progress-context";

type FtueBackDestination = {
  history: FtuePhase[];
  phase: FtuePhase;
};

export function getPostAccountOrganizationPhase(
  organizationMemberCount: number
): FtuePhase {
  return organizationMemberCount > 0
    ? OnboardingPhase.ChooseOrganization
    : OnboardingPhase.CreateOrganization;
}

export function popPreviousFtuePhase(
  history: readonly FtuePhase[]
): FtueBackDestination | null {
  const phase = history.at(-1);
  if (!phase) {
    return null;
  }
  return {
    history: history.slice(0, -1),
    phase,
  };
}

/**
 * The most recent phase in `history` the wizard actually screens, or
 * `undefined` when none of them is one.
 *
 * For the beat where the flow has left the wizard's rendered set but the modal
 * is still on screen: `open` is already false and the dialog keeps its body
 * mounted through the ~200ms exit animation, so a host holding no current
 * wizard phase would swap the body out mid-fade. The screen the user just
 * completed is the one that should be fading (ISS-8345).
 */
export function lastWizardPhase(
  history: readonly FtuePhase[]
): WizardPhase | undefined {
  return [...history].reverse().find(isWizardPhase);
}
