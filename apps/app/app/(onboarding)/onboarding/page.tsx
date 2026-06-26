"use client";

import { useOnboardingStatus } from "@repo/app/onboarding/hooks/use-onboarding";
import { useNavigation } from "@repo/navigation/use-navigation";
import { useEffect } from "react";
import { OnboardingWizard } from "./components/onboarding-wizard";

export default function OnboardingPage() {
  const navigation = useNavigation();
  const { data: status, isLoading } = useOnboardingStatus();

  // Redirect away if wizard is already completed
  useEffect(() => {
    if (status?.wizardCompleted) {
      navigation.replace("/my-tasks");
    }
  }, [status?.wizardCompleted, navigation]);

  if (isLoading || status?.wizardCompleted) {
    return null;
  }

  return <OnboardingWizard />;
}
