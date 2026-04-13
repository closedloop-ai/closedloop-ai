import { OnboardingStep } from "@repo/api/src/types/onboarding";

export const ONBOARDING_STEPS = [
  OnboardingStep.Welcome,
  OnboardingStep.DownloadElectronApp,
  OnboardingStep.CreateTeam,
  OnboardingStep.CreateProject,
  OnboardingStep.ConnectGitHub,
  OnboardingStep.AddAnthropicKey,
  OnboardingStep.ConnectOptionalIntegrations,
  OnboardingStep.Complete,
] as const;

const WIZARD_STATE_KEY = "onboarding_wizard_state";

export type WizardState = {
  currentStep: OnboardingStep;
  createdTeamId: string | null;
  createdTeamName: string | null;
  createdProjectId: string | null;
  createdProjectName: string | null;
};

export function saveWizardState(state: WizardState): void {
  try {
    sessionStorage.setItem(WIZARD_STATE_KEY, JSON.stringify(state));
  } catch {
    // sessionStorage may be unavailable (e.g. private browsing quota exceeded)
  }
}

export function loadWizardState(): WizardState | null {
  try {
    const raw = sessionStorage.getItem(WIZARD_STATE_KEY);
    if (!raw) {
      return null;
    }
    return JSON.parse(raw) as WizardState;
  } catch {
    return null;
  }
}

export function clearWizardState(): void {
  try {
    sessionStorage.removeItem(WIZARD_STATE_KEY);
  } catch {
    // sessionStorage may be unavailable
  }
}

export function setOnboardingReturnCookie(): void {
  // biome-ignore lint/suspicious/noDocumentCookie: Cookie Store API not universally supported; simple cookie write is fine here
  document.cookie = "onboarding_return=1; path=/; max-age=600; SameSite=Lax";
}
