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
  // Also check isFetching to avoid redirecting on stale cache during refetch
  // (e.g. after completing the wizard, invalidateQueries triggers a refetch)
  // TODO: Convert to server component guard for SSR — tracked for follow-up
  const { data: status, isLoading, isFetching } = useOnboardingStatus();

  useEffect(() => {
    if (!(isLoading || isFetching) && status && !status.wizardCompleted) {
      router.replace("/onboarding");
    }
  }, [isLoading, isFetching, status, router]);

  if (isLoading || isFetching) {
    return null;
  }

  if (status && !status.wizardCompleted) {
    return null;
  }

  return children;
}
