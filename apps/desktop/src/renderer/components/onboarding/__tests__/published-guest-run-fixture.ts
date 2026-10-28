/**
 * ISS-11480: a guest run published through the REAL run-override store, the way
 * `DesktopGuidedOnboardingDialogHost` publishes one, whose poster records what
 * it was asked to apply. Shared by the entry-point wiring suites so each can
 * assert its press reaches the published run rather than some other seam.
 */

import { OnboardingEvent } from "@repo/api/src/types/onboarding-events";
import type { GuidedOnboardingSnapshot } from "@repo/api/src/types/onboarding-guided";
import {
  OnboardingRestoreOutcome,
  serializeOnboardingState,
} from "@repo/api/src/types/onboarding-persistence";
import {
  createInitialOnboardingState,
  OnboardingPhase,
  PendingOnboardingStep,
} from "@repo/api/src/types/onboarding-phase";
import { WorkspaceExperience } from "@repo/api/src/types/workspace-experience";
import type { GuidedOnboardingRun } from "@repo/app/onboarding/lib/guided-onboarding-run";
import { act } from "@testing-library/react";
import { guestServerOnboardingContext } from "../guest-onboarding-context";
import {
  clearGuidedOnboardingRunOverride,
  setGuidedOnboardingRunOverride,
} from "../guided-onboarding-run-override-store";

type PostedTransition = Parameters<GuidedOnboardingRun["postTransition"]>;

export type RecordingGuestRun = {
  /** Every `postTransition` call, oldest first. */
  posted: PostedTransition[];
  snapshot: GuidedOnboardingSnapshot;
  /** Clears the store, only if this run is still the published one. */
  withdraw: () => void;
};

/** The one event every guest "Create account" entry point posts. */
export const RESUME_CREATE_ACCOUNT = {
  step: PendingOnboardingStep.CreateAccount,
  type: OnboardingEvent.ResumePendingStep,
} as const;

export function publishRecordingGuestRun(): RecordingGuestRun {
  const posted: PostedTransition[] = [];
  const snapshot: GuidedOnboardingSnapshot = {
    attemptId: null,
    context: guestServerOnboardingContext(true),
    experienceVariant: WorkspaceExperience.V2,
    restoreOutcome: OnboardingRestoreOutcome.Restored,
    revision: 4,
    state: serializeOnboardingState({
      ...createInitialOnboardingState(),
      phase: OnboardingPhase.DashboardAvailable,
    }),
  };
  const run: GuidedOnboardingRun = {
    isLoading: false,
    postTransition: (...call) => {
      posted.push(call);
    },
    snapshot,
  };
  act(() => setGuidedOnboardingRunOverride(run));
  return {
    posted,
    snapshot,
    withdraw: () => act(() => clearGuidedOnboardingRunOverride(run)),
  };
}
