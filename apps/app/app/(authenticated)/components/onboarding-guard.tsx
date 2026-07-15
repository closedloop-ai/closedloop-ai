"use client";

import { useOnboardingStatus } from "@repo/app/onboarding/hooks/use-onboarding";
import { useNavigation } from "@repo/navigation/use-navigation";
import { usePath } from "@repo/navigation/use-path";
import type { ReactNode } from "react";
import { useEffect } from "react";

type OnboardingGuardProps = {
  readonly children: ReactNode;
};

/**
 * Paths that must stay reachable before the onboarding wizard is complete.
 *
 * The desktop loopback authorize/consent page (FEA-2460) is opened in the
 * browser right after sign-up, while the desktop waits on a short-lived
 * authorization code. Forcing a brand-new user through the wizard first would
 * drop the OAuth params from the URL and let the code expire — the exact
 * new-user dead-end that flow exists to remove. The route is reachable both
 * org-scoped (`/{orgSlug}/settings/…`) and via the bare fallback, so match on
 * the shared trailing segment.
 */
const ONBOARDING_EXEMPT_PATH_SUFFIX =
  "/settings/integrations/desktop/authorize";

function isOnboardingExemptPath(pathname: string): boolean {
  return pathname.endsWith(ONBOARDING_EXEMPT_PATH_SUFFIX);
}

/**
 * Redirects users to /onboarding if the wizard has not been completed.
 * Renders nothing while the status is loading to avoid flash of content.
 * Exempt paths ({@link ONBOARDING_EXEMPT_PATH_SUFFIX}) render immediately.
 */
export function OnboardingGuard({ children }: OnboardingGuardProps) {
  const navigation = useNavigation();
  const pathname = usePath();
  const exempt = isOnboardingExemptPath(pathname);
  // Also check isFetching to avoid redirecting on stale cache during refetch
  // (e.g. after completing the wizard, invalidateQueries triggers a refetch)
  // TODO: Convert to server component guard for SSR — tracked for follow-up
  const { data: status, isLoading, isFetching } = useOnboardingStatus();

  const shouldRedirect =
    !exempt && status !== undefined && !status.wizardCompleted;

  useEffect(() => {
    if (!(isLoading || isFetching) && shouldRedirect) {
      navigation.replace("/onboarding");
    }
  }, [isLoading, isFetching, shouldRedirect, navigation]);

  // Exempt paths render regardless of onboarding/fetch state: the consent page
  // owns its own states and must not blank out during a status refetch.
  if (exempt) {
    return children;
  }

  if (isLoading || isFetching) {
    return null;
  }

  if (shouldRedirect) {
    return null;
  }

  return children;
}
