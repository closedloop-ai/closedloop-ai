"use client";

import { useRouter } from "next/navigation";
import type { ReactNode } from "react";
import { useEffect } from "react";
import { useOnboardingStatus } from "@/hooks/queries/use-onboarding";

type OnboardingGuardProps = {
  readonly children: ReactNode;
};

/**
 * Redirects users to /onboarding if the wizard has not been completed.
 * Renders nothing while the status is loading to avoid flash of content.
 */
export function OnboardingGuard({ children }: OnboardingGuardProps) {
  const router = useRouter();
  const { data: status, isLoading } = useOnboardingStatus();

  useEffect(() => {
    if (!isLoading && status && !status.wizardCompleted) {
      router.replace("/onboarding");
    }
  }, [isLoading, status, router]);

  if (isLoading) {
    return null;
  }

  if (status && !status.wizardCompleted) {
    return null;
  }

  return children;
}
