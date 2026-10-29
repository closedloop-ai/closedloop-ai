"use client";

import {
  ChecklistItemId,
  OnboardingStep,
} from "@repo/api/src/types/onboarding";
import { useCompleteWizard } from "@repo/app/onboarding/hooks/use-onboarding";
import { useChecklistItemCompletedCapture } from "@repo/app/onboarding/hooks/use-onboarding-checklist-analytics";
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
  const { captureChecklistItemCompleted } = useChecklistItemCompletedCapture();

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

  const handleTeamCreated = useCallback(
    (teamId: string, teamName: string) => {
      // PRD-736 (ISS-10500): the wizard completes this checklist item itself,
      // on a route where the checklist card is not mounted to observe it.
      captureChecklistItemCompleted(ChecklistItemId.CreateTeam);
      setState((prev) => ({
        ...prev,
        createdTeamId: teamId,
        createdTeamName: teamName,
        currentStep: OnboardingStep.CreateProject,
      }));
    },
    [captureChecklistItemCompleted]
  );

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
            captureChecklistItemCompleted(ChecklistItemId.CreateProject);
            handleComplete();
            navigation.navigate(POST_WIZARD_ROUTE);
          },
        }
      );
    },
    [
      captureChecklistItemCompleted,
      completeWizard,
      state.createdTeamId,
      handleComplete,
      navigation,
    ]
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
