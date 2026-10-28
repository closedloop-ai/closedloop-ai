"use client";

import { OnboardingPhase } from "@repo/api/src/types/onboarding-phase";
import type { WizardPhase } from "@repo/app/onboarding/components/guided-onboarding-types"; // Cross-slice: preview shell runs the real onboarding flow (ISS-12938).
import { createContext, type ReactNode, useContext } from "react";

/**
 * Every phase this prototype's FTUE state can sit at: the wizard's RENDERED set
 * plus `dashboard_available`, the phase the blocking modal closes on. The flow
 * rests there with the dialog dismissed, so it is a legitimate persisted and
 * navigable phase that deliberately has no wizard screen — which is why it is
 * added here rather than left inside `WizardPhase`, where it would owe the
 * registry a component it cannot honestly supply (ISS-8345).
 */
export type FtuePhase = WizardPhase | typeof OnboardingPhase.DashboardAvailable;

type FtueProgressValue = {
  phase: FtuePhase;
  progress: number;
};

const FtueProgressContext = createContext<FtueProgressValue>({
  phase: OnboardingPhase.Welcome,
  progress: 0,
});

export function FtueProgressProvider({
  children,
  phase,
  progress,
}: FtueProgressValue & { children: ReactNode }) {
  return (
    <FtueProgressContext value={{ phase, progress }}>
      {children}
    </FtueProgressContext>
  );
}

export const useFtueProgress = () => useContext(FtueProgressContext);

// Whether a phase keeps the background analysis status visible. The shell (which
// reserves the layout offset) and the banner (which renders it) must agree, so
// both read this predicate instead of repeating the phase list.
//
// Exhaustive over `FtuePhase` rather than a `readonly FtuePhase[]` of the true
// ones: an array admits a subset, so a phase added to the wizard would compile
// here with no decision made and silently fall to "no banner". The record makes
// the classification mandatory — a new phase fails `tsc` until someone states
// which side it is on.
const ANALYSIS_STATUS_PHASE = {
  [OnboardingPhase.Welcome]: false,
  [OnboardingPhase.SessionDiscovery]: false,
  [OnboardingPhase.Account]: true,
  [OnboardingPhase.CreateOrganization]: true,
  [OnboardingPhase.ChooseOrganization]: true,
  [OnboardingPhase.SyncPolicy]: true,
  [OnboardingPhase.DownloadDesktop]: false,
  [OnboardingPhase.InviteTeam]: true,
  [OnboardingPhase.ConnectGitHub]: true,
  [OnboardingPhase.DashboardAvailable]: true,
} as const satisfies Record<FtuePhase, boolean>;

export function isAnalysisStatusPhase(phase: FtuePhase) {
  return ANALYSIS_STATUS_PHASE[phase];
}
