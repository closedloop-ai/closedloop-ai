/**
 * @file onboarding-completion.ts
 * @description The deferred-completion contract (ISS-8349): which skipped step
 * the sidebar card offers next, and the phase resuming it re-enters.
 *
 * This is the diagram's `PendingStep` choice pseudo-state. The card shows ONE
 * item at a time, in the priority PRD-689 documents: Desktop account → Web
 * Desktop download → GitHub connection → team invitation → Desktop sync choice.
 *
 * EVERY step resumes into a PHASE (ISS-11249). The sync choice used to be the
 * one exception — it sent the reader out to the Connected Devices settings panel
 * instead of the {@link OnboardingPhase.SyncPolicy} screen that already renders
 * that choice, so the one election the onboarding run owns was the one election
 * it did not present. Settings remains a valid place to CHANGE the answer later;
 * it is no longer where the run goes to take it.
 */

import {
  AccountStatus,
  KnownFlag,
  type OnboardingContext,
  OnboardingHost,
  OnboardingPhase,
  OrganizationMembership,
  PendingOnboardingStep,
} from "./onboarding-phase.ts";

/**
 * Rank per step, lowest first. An exhaustive `Record` rather than a bare array
 * so adding a {@link PendingOnboardingStep} member fails `tsc` here instead of
 * silently sorting last — the side-inventory hole called out in the repo's
 * review lessons.
 */
const PENDING_STEP_RANK: Record<PendingOnboardingStep, number> = {
  [PendingOnboardingStep.CreateAccount]: 1,
  [PendingOnboardingStep.DownloadDesktop]: 2,
  [PendingOnboardingStep.ConnectGitHub]: 3,
  [PendingOnboardingStep.InviteTeam]: 4,
  [PendingOnboardingStep.ChooseSessionSync]: 5,
};

/** The documented priority order, derived from the exhaustive rank record. */
export const PENDING_STEP_PRIORITY: readonly PendingOnboardingStep[] =
  Object.keys(PENDING_STEP_RANK)
    .sort(
      (left, right) =>
        PENDING_STEP_RANK[left as PendingOnboardingStep] -
        PENDING_STEP_RANK[right as PendingOnboardingStep]
    )
    .map((step) => step as PendingOnboardingStep);

/**
 * The blocking phase a resumed step re-enters. Exhaustive over every
 * {@link PendingOnboardingStep}, so a new step must name the screen that answers
 * it rather than being routed somewhere outside the run.
 */
const PENDING_STEP_PHASE: Record<PendingOnboardingStep, OnboardingPhase> = {
  [PendingOnboardingStep.CreateAccount]: OnboardingPhase.Account,
  [PendingOnboardingStep.DownloadDesktop]: OnboardingPhase.DownloadDesktop,
  [PendingOnboardingStep.ConnectGitHub]: OnboardingPhase.ConnectGitHub,
  [PendingOnboardingStep.InviteTeam]: OnboardingPhase.InviteTeam,
  [PendingOnboardingStep.ChooseSessionSync]: OnboardingPhase.SyncPolicy,
};

/**
 * The hosts each step exists on. An exhaustive `Record` for the same reason as
 * {@link PENDING_STEP_RANK}: a new step must declare where it applies rather
 * than defaulting into every host's checklist.
 *
 * Applicability is deliberately separate from whether a step is outstanding.
 * Folding the two together made a step that a host never shows read as one the
 * user had completed, which is what inflated the Desktop denominator before
 * the sync-choice item joined the list (ISS-8349 review, ISS-8353 amendment).
 */
const STEP_HOSTS: Record<PendingOnboardingStep, readonly OnboardingHost[]> = {
  // Only Desktop can defer the account; Web required it to get this far.
  [PendingOnboardingStep.CreateAccount]: [OnboardingHost.Desktop],
  // The installer gate is Web-only; a Desktop user already has the app.
  [PendingOnboardingStep.DownloadDesktop]: [OnboardingHost.Web],
  [PendingOnboardingStep.ConnectGitHub]: [
    OnboardingHost.Desktop,
    OnboardingHost.Web,
  ],
  [PendingOnboardingStep.InviteTeam]: [
    OnboardingHost.Desktop,
    OnboardingHost.Web,
  ],
  [PendingOnboardingStep.ChooseSessionSync]: [OnboardingHost.Desktop],
};

/** Whether `step` is part of this host's checklist at all. */
function isStepApplicable(
  step: PendingOnboardingStep,
  context: OnboardingContext
): boolean {
  return STEP_HOSTS[step].includes(context.host);
}

/** Whether an applicable `step` still has work left in it. */
function isStepOutstanding(
  step: PendingOnboardingStep,
  context: OnboardingContext
): boolean {
  switch (step) {
    case PendingOnboardingStep.CreateAccount:
      return context.accountStatus === AccountStatus.Skipped;
    case PendingOnboardingStep.DownloadDesktop:
      return !context.desktopAppDownloaded;
    case PendingOnboardingStep.ConnectGitHub:
      return !context.githubConnected;
    case PendingOnboardingStep.InviteTeam:
      return !context.teamInvited;
    case PendingOnboardingStep.ChooseSessionSync:
      return context.syncConsentRecorded !== KnownFlag.Yes;
    default: {
      const exhaustiveStep: never = step;
      return exhaustiveStep;
    }
  }
}

/** Whether one specific step is still outstanding for this context. */
function isStepPending(
  step: PendingOnboardingStep,
  context: OnboardingContext
): boolean {
  return isStepApplicable(step, context) && isStepOutstanding(step, context);
}

/**
 * The steps this host's checklist tracks at all, in the documented priority
 * order. This is the denominator the completion card counts against.
 */
export function listApplicableOnboardingSteps(
  context: OnboardingContext
): readonly PendingOnboardingStep[] {
  return PENDING_STEP_PRIORITY.filter((step) =>
    isStepApplicable(step, context)
  );
}

/** Every outstanding step, in the documented priority order. */
export function listPendingOnboardingSteps(
  context: OnboardingContext
): readonly PendingOnboardingStep[] {
  return PENDING_STEP_PRIORITY.filter((step) => isStepPending(step, context));
}

/**
 * The single step the completion card offers, or `null` when nothing is
 * outstanding and the user is {@link OnboardingPhase.Ready}.
 */
export function resolvePendingOnboardingStep(
  context: OnboardingContext
): PendingOnboardingStep | null {
  return listPendingOnboardingSteps(context)[0] ?? null;
}

/**
 * How many of this host's steps the context has finished, and out of how many.
 *
 * Both halves come from the host-applicable set. Counting against every step
 * silently credited hosts with tasks they never show: Web with the Desktop-only
 * sync choice, and Desktop with the Web-only installer download.
 */
export function summarizeOnboardingCompletion(context: OnboardingContext): {
  completed: number;
  total: number;
} {
  const applicable = listApplicableOnboardingSteps(context);
  const outstanding = applicable.filter((step) =>
    isStepOutstanding(step, context)
  );
  return {
    completed: applicable.length - outstanding.length,
    total: applicable.length,
  };
}

/** The phase a resumed `step` re-enters. */
export function phaseForPendingStep(
  step: PendingOnboardingStep
): OnboardingPhase {
  return PENDING_STEP_PHASE[step];
}

/**
 * Whether the Web download gate may be skipped.
 *
 * ISS-12482 (operator ruling, 2026-10-14): the first user of an organization
 * must download Desktop; any later member may skip. This replaces PRD-689's
 * synced-session-data signal.
 *
 * Takes only the field it reads rather than a whole {@link OnboardingContext},
 * so a client holding just the membership can ask this owner instead of copying
 * the comparison (ISS-8350). Every full context still satisfies the `Pick`.
 */
export function canSkipDesktopDownload(
  context: Pick<OnboardingContext, "membership">
): boolean {
  return context.membership === OrganizationMembership.ExistingMember;
}
