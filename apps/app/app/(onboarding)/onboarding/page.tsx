"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";
import { useOnboardingStatus } from "@/hooks/queries/use-onboarding";
import { OnboardingWizard } from "./components/onboarding-wizard";

export default function OnboardingPage() {
  const router = useRouter();
  const { data: status, isLoading } = useOnboardingStatus();

  // Redirect away if wizard is already completed
  useEffect(() => {
    if (status?.wizardCompleted) {
      router.replace("/my-tasks");
    }
  }, [status?.wizardCompleted, router]);

  if (isLoading || status?.wizardCompleted) {
    return null;
  }

  return <OnboardingWizard />;
}
