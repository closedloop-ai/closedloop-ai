"use client";

import { OnboardingStep } from "@repo/api/src/types/onboarding";
import { useCallback, useState } from "react";
import { AddAnthropicKeyStep } from "./add-anthropic-key-step";
import { CompleteStep } from "./complete-step";
import { ConnectGitHubStep } from "./connect-github-step";
import { ConnectOptionalIntegrationsStep } from "./connect-optional-integrations-step";
import { CreateProjectStep } from "./create-project-step";
import { CreateTeamStep } from "./create-team-step";
import { WelcomeStep } from "./welcome-step";
import { WizardShell } from "./wizard-shell";

const STEPS = [
  OnboardingStep.Welcome,
  OnboardingStep.CreateTeam,
  OnboardingStep.CreateProject,
  OnboardingStep.ConnectGitHub,
  OnboardingStep.AddAnthropicKey,
  OnboardingStep.ConnectOptionalIntegrations,
  OnboardingStep.Complete,
] as const;

type WizardState = {
  currentStep: OnboardingStep;
  createdTeamId: string | null;
  createdTeamName: string | null;
  createdProjectId: string | null;
  createdProjectName: string | null;
};

export function OnboardingWizard() {
  const [state, setState] = useState<WizardState>({
    currentStep: OnboardingStep.Welcome,
    createdTeamId: null,
    createdTeamName: null,
    createdProjectId: null,
    createdProjectName: null,
  });

  const goToStep = useCallback((step: OnboardingStep) => {
    setState((prev) => ({ ...prev, currentStep: step }));
  }, []);

  const goBack = useCallback(() => {
    const currentIndex = STEPS.indexOf(state.currentStep);
    if (currentIndex > 0) {
      goToStep(STEPS[currentIndex - 1]);
    }
  }, [state.currentStep, goToStep]);

  const handleTeamCreated = useCallback((teamId: string, teamName: string) => {
    setState((prev) => ({
      ...prev,
      createdTeamId: teamId,
      createdTeamName: teamName,
      currentStep: OnboardingStep.CreateProject,
    }));
  }, []);

  const handleProjectCreated = useCallback(
    (projectId: string, projectName: string) => {
      setState((prev) => ({
        ...prev,
        createdProjectId: projectId,
        createdProjectName: projectName,
        currentStep: OnboardingStep.ConnectGitHub,
      }));
    },
    []
  );

  return (
    <WizardShell currentStep={state.currentStep} onBack={goBack}>
      {state.currentStep === OnboardingStep.Welcome && (
        <WelcomeStep onNext={() => goToStep(OnboardingStep.CreateTeam)} />
      )}

      {state.currentStep === OnboardingStep.CreateTeam && (
        <CreateTeamStep
          createdTeamId={state.createdTeamId}
          createdTeamName={state.createdTeamName}
          onNext={handleTeamCreated}
        />
      )}

      {state.currentStep === OnboardingStep.CreateProject && (
        <CreateProjectStep
          createdProjectId={state.createdProjectId}
          createdProjectName={state.createdProjectName}
          onNext={handleProjectCreated}
          teamId={state.createdTeamId ?? ""}
        />
      )}

      {state.currentStep === OnboardingStep.ConnectGitHub && (
        <ConnectGitHubStep
          onNext={() => goToStep(OnboardingStep.AddAnthropicKey)}
        />
      )}

      {state.currentStep === OnboardingStep.AddAnthropicKey && (
        <AddAnthropicKeyStep
          onNext={() => goToStep(OnboardingStep.ConnectOptionalIntegrations)}
        />
      )}

      {state.currentStep === OnboardingStep.ConnectOptionalIntegrations && (
        <ConnectOptionalIntegrationsStep
          onNext={() => goToStep(OnboardingStep.Complete)}
        />
      )}

      {state.currentStep === OnboardingStep.Complete && (
        <CompleteStep
          createdProjectId={state.createdProjectId}
          createdProjectName={state.createdProjectName}
          createdTeamId={state.createdTeamId}
          createdTeamName={state.createdTeamName}
        />
      )}
    </WizardShell>
  );
}
