/**
 * @file ISS-12363: the Web setup gate — what a reader must finish before the
 * workspace opens, and which of those steps comes next.
 *
 * Downloading Desktop alone used to read as "set up": a first user could
 * install, reach the web app without ever choosing a sync policy, and land on a
 * workspace with no synced data and no next step. The gate therefore has TWO
 * steps, and the first user in an organization is held until both are done.
 * Everyone after them only sees the same two steps in the completion card,
 * because they can already read what their teammates share.
 *
 * The sync step is complete on a CHOICE, never on a level. `Off` is a valid
 * answer and finishes the step exactly as `Full` does; `null` — nobody has
 * chosen — is the only incomplete value. Folding the two together is what
 * either forces data sharing (treating Off as unfinished) or hides the dead end
 * (treating unset as Off).
 *
 * Production contract (presumed, see web-master `prototype.meta.ts`):
 * `syncPolicy` stands for a per-USER "has made an explicit sync choice" fact,
 * not the per-device policy — the first choice on any device releases the gate.
 *
 * Steps reuse {@link PendingOnboardingStep} members so every surface that
 * renders them reads the same labels and glyphs as the completion card
 * (`GETTING_STARTED_STEP_CONTENT`).
 */

import {
  OrganizationMembership,
  PendingOnboardingStep,
} from "@repo/api/src/types/onboarding-phase";
import type { SyncConsentLevel } from "../components/sync-consent";

/** The gate's steps, in the order a reader completes them. */
export const SETUP_GATE_STEPS = [
  PendingOnboardingStep.DownloadDesktop,
  PendingOnboardingStep.ChooseSessionSync,
] as const;

export type SetupGateStep = (typeof SETUP_GATE_STEPS)[number];

export type SetupGateStepState = {
  complete: boolean;
  step: SetupGateStep;
};

export type SetupGate = {
  /** Whether the non-dismissible modal must stay open for this reader. */
  blocking: boolean;
  /** The first incomplete step, or `null` once both are done. */
  nextStep: SetupGateStep | null;
  steps: readonly SetupGateStepState[];
};

export type SetupGateInput = {
  desktopAppDownloaded: boolean;
  /**
   * The organization membership exactly as it arrived. `unknown` because the
   * snapshot carries no response-side schema; a missing or unrecognized value is
   * neither a first user nor an existing member.
   */
  membership: unknown;
  /** The reader's sync choice, or `null` when none has been made. */
  syncPolicy: SyncConsentLevel | null;
};

export function resolveSetupGate({
  desktopAppDownloaded,
  membership,
  syncPolicy,
}: SetupGateInput): SetupGate {
  const steps: readonly SetupGateStepState[] = [
    {
      complete: desktopAppDownloaded,
      step: PendingOnboardingStep.DownloadDesktop,
    },
    {
      complete: syncPolicy !== null,
      step: PendingOnboardingStep.ChooseSessionSync,
    },
  ];
  const nextStep = steps.find((state) => !state.complete)?.step ?? null;
  // Only a MEASURED existing member is let through. An unread membership fails
  // closed, the same way ISS-12482 withholds the download skip on it: letting an
  // unmeasured first user into an empty workspace is the dead end this gate
  // exists to remove.
  const exempt = membership === OrganizationMembership.ExistingMember;
  return {
    blocking: !exempt && nextStep !== null,
    nextStep,
    steps,
  };
}

/**
 * Whether the gate still holds this reader on `step`: the gate is blocking and
 * that step is incomplete. The one predicate a host routes the modal on, so no
 * host re-derives "first user and nothing chosen" on its own.
 */
export function isSetupGateStepOwed(
  gate: SetupGate,
  step: SetupGateStep
): boolean {
  return (
    gate.blocking &&
    gate.steps.some((state) => state.step === step && !state.complete)
  );
}
