"use client";

import { OnboardingPhase } from "@repo/api/src/types/onboarding-phase";
import type { ComponentType, ReactElement } from "react";
import {
  GuidedOnboardingAccountStep,
  selectAccountStepProps,
} from "./guided-onboarding-account-step";
import {
  GuidedOnboardingAnalysisStep,
  selectAnalysisStepProps,
} from "./guided-onboarding-analysis-step";
import {
  GuidedOnboardingChooseOrganizationStep,
  selectChooseOrganizationStepProps,
} from "./guided-onboarding-choose-organization-step";
import {
  GuidedOnboardingCreateOrganizationStep,
  selectCreateOrganizationStepProps,
} from "./guided-onboarding-create-organization-step";
import {
  GuidedOnboardingDownloadStep,
  selectDownloadStepProps,
} from "./guided-onboarding-download-step";
import {
  GuidedOnboardingGitHubStep,
  selectGitHubStepProps,
} from "./guided-onboarding-github-step";
import {
  GuidedOnboardingInviteStep,
  selectInviteStepProps,
} from "./guided-onboarding-invite-step";
import {
  GuidedOnboardingSyncStep,
  selectSyncStepProps,
} from "./guided-onboarding-sync-step";
import type {
  GuidedOnboardingPhaseSource,
  WizardPhase,
} from "./guided-onboarding-types";
import {
  GuidedOnboardingWelcomeStep,
  selectWelcomeStepProps,
} from "./guided-onboarding-welcome-step";

/**
 * One phase's whole contribution to the wizard, reduced to the only thing the
 * shell needs from it. The component and its selector are erased behind
 * `render` so the registry can be a homogeneous `Record<WizardPhase, _>` while
 * each phase keeps its own props type — {@link definePhase} still typechecks the
 * pairing, because a selector's return type must BE that component's props.
 */
export type GuidedOnboardingPhaseEntry = {
  render: (source: GuidedOnboardingPhaseSource) => ReactElement;
};

/**
 * The wizard's extension interface: every phase-to-component pairing, stated
 * once. Adding a phase is a component file, a selector beside it, and one line
 * here — the shell is not edited (ISS-8345).
 *
 * Exhaustive over {@link WizardPhase} by construction, so a phase added to the
 * wizard fails `tsc` here rather than falling through to a plausible screen. A
 * phase the modal has already exited on does not belong in it: it belongs in
 * `WIZARD_RENDERS_PHASE` as `false`, which is what keeps this record and that
 * one from disagreeing.
 */
export const GUIDED_ONBOARDING_PHASES = {
  [OnboardingPhase.Welcome]: definePhase(
    GuidedOnboardingWelcomeStep,
    selectWelcomeStepProps
  ),
  [OnboardingPhase.SessionDiscovery]: definePhase(
    GuidedOnboardingAnalysisStep,
    selectAnalysisStepProps
  ),
  [OnboardingPhase.Account]: definePhase(
    GuidedOnboardingAccountStep,
    selectAccountStepProps
  ),
  [OnboardingPhase.CreateOrganization]: definePhase(
    GuidedOnboardingCreateOrganizationStep,
    selectCreateOrganizationStepProps
  ),
  [OnboardingPhase.ChooseOrganization]: definePhase(
    GuidedOnboardingChooseOrganizationStep,
    selectChooseOrganizationStepProps
  ),
  [OnboardingPhase.SyncPolicy]: definePhase(
    GuidedOnboardingSyncStep,
    selectSyncStepProps
  ),
  [OnboardingPhase.DownloadDesktop]: definePhase(
    GuidedOnboardingDownloadStep,
    selectDownloadStepProps
  ),
  [OnboardingPhase.InviteTeam]: definePhase(
    GuidedOnboardingInviteStep,
    selectInviteStepProps
  ),
  [OnboardingPhase.ConnectGitHub]: definePhase(
    GuidedOnboardingGitHubStep,
    selectGitHubStepProps
  ),
} as const satisfies Record<WizardPhase, GuidedOnboardingPhaseEntry>;

function definePhase<Props extends object>(
  Component: ComponentType<Props>,
  select: (source: GuidedOnboardingPhaseSource) => Props
): GuidedOnboardingPhaseEntry {
  return { render: (source) => <Component {...select(source)} /> };
}
