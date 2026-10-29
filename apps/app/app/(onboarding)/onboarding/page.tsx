"use client";

import { OnboardingStatusUnavailable } from "@repo/app/onboarding/components/onboarding-status-unavailable";
import { useOnboardingStatus } from "@repo/app/onboarding/hooks/use-onboarding";
import { isOnboardingStatusReadFailing } from "@repo/app/onboarding/lib/onboarding-status-read";
import { WEB_CANONICAL_LANDING_HREF } from "@repo/app/shared/lib/primary-nav-destinations";
import { useNavigation } from "@repo/navigation/use-navigation";
import { useEffect } from "react";
import { OnboardingWizard } from "./components/onboarding-wizard";

export default function OnboardingPage() {
  const navigation = useNavigation();
  const statusQuery = useOnboardingStatus();
  const { data: status, isFetching, refetch } = statusQuery;

  // Redirect away if wizard is already completed
  useEffect(() => {
    if (status?.wizardCompleted) {
      navigation.replace(WEB_CANONICAL_LANDING_HREF);
    }
  }, [status?.wizardCompleted, navigation]);

  // ISS-5991: keyed off the ANSWER, not off a loading flag. The status query is
  // gated on a hydrated identity, and a gated-off query reports
  // `isLoading: false` with no data — so branching on that flag started first-run
  // setup for a user who had already finished it. This page owns one screen, so
  // it renders the wizard only once the status positively says setup is
  // unfinished; the authenticated shell's guard cannot (see onboarding-guard).
  if (status !== undefined) {
    return status.wizardCompleted ? null : <OnboardingWizard />;
  }

  // ISS-7828: with no answer, a terminal failure renders the recoverable card
  // instead of the blank page it used to leave. It stays up through Retry's own
  // read: a refetch with no data resets the query to pending and clears
  // `isError`, so the failure already on record is what keeps it mounted. A
  // session rejection gets the same card here: this route group has no session
  // guard, Retry recovers a token race, and the server layout already redirects
  // a visitor with no Clerk session. Rendered bare, so the layout column places
  // it where the wizard starts.
  if (isOnboardingStatusReadFailing(statusQuery)) {
    return (
      <OnboardingStatusUnavailable
        onRetry={() => {
          refetch();
        }}
        retrying={isFetching}
      />
    );
  }

  return null;
}
