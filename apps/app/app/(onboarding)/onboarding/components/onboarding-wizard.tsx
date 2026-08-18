"use client";

import { OnboardingStep } from "@repo/api/src/types/onboarding";
import { useCompleteWizard } from "@repo/app/onboarding/hooks/use-onboarding";
import { useNavigation } from "@repo/navigation/use-navigation";
import { useCallback, useEffect, useState } from "react";
import {
  clampStep,
  clearWizardState,
  loadWizardState,
  ONBOARDING_STEPS,
  POST_WIZARD_ROUTE,
  saveWizardState,
  type WizardState,
} from "../lib/onboarding-constants";
import { CreateProjectStep } from "./create-project-step";
import { CreateTeamStep } from "./create-team-step";
import { WizardShell } from "./wizard-shell";

const DEFAULT_STATE: WizardState = {
  currentStep: OnboardingStep.CreateTeam,
  createdTeamId: null,
  createdTeamName: null,
  createdProjectId: null,
  createdProjectName: null,
};

export function OnboardingWizard() {
  const [state, setState] = useState<WizardState>(() => {
    return loadWizardState() ?? DEFAULT_STATE;
  });
  const navigation = useNavigation();
  const completeWizard = useCompleteWizard();

  const currentStep = clampStep(state);

  // Persist wizard state to sessionStorage on every change
  useEffect(() => {
    saveWizardState(state);
  }, [state]);

  const goBack = useCallback(() => {
    const currentIndex = ONBOARDING_STEPS.indexOf(currentStep);
    if (currentIndex > 0) {
      setState((prev) => ({
        ...prev,
        currentStep: ONBOARDING_STEPS[currentIndex - 1],
      }));
    }
  }, [currentStep]);

  const handleTeamCreated = useCallback((teamId: string, teamName: string) => {
    setState((prev) => ({
      ...prev,
      createdTeamId: teamId,
      createdTeamName: teamName,
      currentStep: OnboardingStep.CreateProject,
    }));
  }, []);

  const handleComplete = useCallback(() => {
    clearWizardState();
  }, []);

  const handleProjectCreated = useCallback(
    (projectId: string, projectName: string) => {
      // Backstop behind the disabled Continue the step renders while this is in
      // flight: a second call issues a second PUT — another read-modify-write of
      // the whole Organization.settings blob — and a second navigate.
      if (completeWizard.isPending) {
        return;
      }

      setState((prev) => ({
        ...prev,
        createdProjectId: projectId,
        createdProjectName: projectName,
      }));

      // Creating the project IS finishing the wizard; there is no later step to
      // own the call.
      completeWizard.mutate(
        {
          createdTeamId: state.createdTeamId ?? undefined,
          createdProjectId: projectId,
        },
        {
          onSuccess: () => {
            handleComplete();
            navigation.navigate(POST_WIZARD_ROUTE);
          },
        }
      );
    },
    [completeWizard, state.createdTeamId, handleComplete, navigation]
  );

  return (
    <WizardShell currentStep={currentStep} onBack={goBack}>
      {currentStep === OnboardingStep.CreateTeam && (
        <CreateTeamStep
          createdTeamId={state.createdTeamId}
          createdTeamName={state.createdTeamName}
          onNext={handleTeamCreated}
        />
      )}

      {currentStep === OnboardingStep.CreateProject &&
        state.createdTeamId !== null && (
          <CreateProjectStep
            completing={completeWizard.isPending}
            createdProjectId={state.createdProjectId}
            createdProjectName={state.createdProjectName}
            onNext={handleProjectCreated}
            teamId={state.createdTeamId}
          />
        )}
    </WizardShell>
  );
}
