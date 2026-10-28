"use client";

import type { GuidedOnboardingSnapshot } from "@repo/api/src/types/onboarding-guided";
import { restoreOnboardingState } from "@repo/api/src/types/onboarding-persistence";
import {
  isBlockingPhase,
  OnboardingHost,
  OnboardingPhase,
} from "@repo/api/src/types/onboarding-phase";
import { OnboardingStatusUnavailable } from "@repo/app/onboarding/components/onboarding-status-unavailable";
import { useGuidedOnboardingSnapshot } from "@repo/app/onboarding/hooks/use-guided-onboarding";
import { useOnboardingStatus } from "@repo/app/onboarding/hooks/use-onboarding";
import { isDesktopAuthorizeConsentPath } from "@repo/app/onboarding/lib/desktop-authorize-consent-path";
import { isOnboardingStatusReadFailing } from "@repo/app/onboarding/lib/onboarding-status-read";
import { useAuthSnapshot } from "@repo/app/shared/auth/use-auth-snapshot";
import {
  getAuthRejected,
  subscribeAuthRejection,
} from "@repo/app/shared/query/auth-rejection-store";
import { useNavigation } from "@repo/navigation/use-navigation";
import { usePath } from "@repo/navigation/use-path";
import type { ReactNode } from "react";
import { useEffect, useSyncExternalStore } from "react";
import { isDesktopOwnedRun } from "./guided-onboarding-run-ownership";

type OnboardingGuardProps = {
  readonly children: ReactNode;
};

/**
 * Redirects users to /onboarding if the wizard has not been completed and the
 * guided run's takeover is not up for them (ISS-11072).
 * Renders nothing while the first status answer is on its way, to avoid a flash
 * of content. When no answer can be had — a terminal failure with no settled
 * status (ISS-7828) — renders the recoverable unavailable card in place of the
 * content region, so an unknown status is treated as neither finished nor blank.
 * The desktop authorize/consent page ({@link isDesktopAuthorizeConsentPath})
 * renders immediately.
 */
export function OnboardingGuard({ children }: OnboardingGuardProps) {
  const navigation = useNavigation();
  const pathname = usePath();
  const exempt = isDesktopAuthorizeConsentPath(pathname);
  // TODO: Convert to server component guard for SSR — tracked for follow-up
  // ISS-5991. This guard wraps the whole authenticated content region, so it
  // blanks ONLY while the first answer is genuinely on its way: identity not
  // hydrated yet, or the initial fetch in flight (`isLoading`). Once an answer
  // exists, a background refetch (the checklist requests
  // `refetchOnWindowFocus: "always"`, and both observers share one query) must
  // not unmount the app around a working sidebar — blanking on `isFetching`
  // did exactly that on every tab refocus (ISS-7089 F3). The post-wizard
  // transition no longer needs it either: `useCompleteWizard` writes its fresh
  // status into the cache synchronously, so there is no stale-cache window to
  // hide.
  //
  // Deliberately NOT `isPending`: a query is also pending between retry attempts
  // and whenever the gate stays shut, neither of which is guaranteed to end, and
  // blanking there empties the app around a working sidebar. Containerized e2e
  // caught exactly that — every branches/sessions surface rendered chrome and no
  // content because a slow `/onboarding` never settled.
  const { isLoaded: identityLoaded } = useAuthSnapshot();
  const statusQuery = useOnboardingStatus();
  const { data: status, isFetching, isLoading, refetch } = statusQuery;
  // `WorkspaceAuthGuard`, inside this guard, replaces the content region for as
  // long as the query boundary holds a session rejection, and no longer: its
  // Retry clears the latch without re-reading this query.
  const sessionRejectionHeld = useSyncExternalStore(
    subscribeAuthRejection,
    getAuthRejected,
    getServerAuthRejected
  );

  // ISS-11072: the legacy team/project wizard is not a prerequisite for a
  // reader the guided run is onboarding, so an incomplete wizard asks the
  // guided run (the same snapshot the sidebar's takeover opens on) before
  // redirecting. A failed guided read keeps the legacy redirect. Blanks only
  // while that read is in flight (`isLoading`, which retry backoff keeps true;
  // not `isPending`, for the reason above: a paused read has no guaranteed end).
  const wizardIncomplete = status !== undefined && !status.wizardCompleted;
  const guidedSnapshot = useGuidedOnboardingSnapshot(OnboardingHost.Web, {
    enabled: wizardIncomplete,
  });
  const guidedAnswerPending = wizardIncomplete && guidedSnapshot.isLoading;
  const guidedAnswered =
    guidedSnapshot.data !== undefined || guidedSnapshot.isError;
  const shouldRedirect =
    !exempt &&
    wizardIncomplete &&
    guidedAnswered &&
    !isDesktopOwnedRun(guidedSnapshot.data) &&
    !guidedRunCompleted(guidedSnapshot.data) &&
    !guidedTakeoverUp(guidedSnapshot.data);

  useEffect(() => {
    if (shouldRedirect) {
      navigation.replace("/onboarding");
    }
  }, [shouldRedirect, navigation]);

  // Exempt paths render regardless of onboarding/fetch state: the consent page
  // owns its own states and must not blank out during a status refetch.
  if (exempt) {
    return children;
  }

  if (!identityLoaded) {
    return null;
  }

  // A settled answer outranks a failed background refetch of it (ISS-7089 F3):
  // the content stays mounted while `isError` is also true.
  if (status !== undefined) {
    return shouldRedirect || guidedAnswerPending ? null : children;
  }

  // ISS-7828: nothing settled, and the shell is holding a session rejection. It
  // is the shell's to recover, so the region goes to `WorkspaceAuthGuard`'s card;
  // the onboarding card would unmount it. Keyed on the held latch rather than on
  // this query's error: once the shell's Retry clears it, a 401 still held here
  // is an unread status like any other failure, never a finished one.
  if (sessionRejectionHeld) {
    return children;
  }

  // A terminal failure with nothing settled to fall back on, or Retry's read of
  // one. A refetch with no data resets the query to pending and clears
  // `isError`, so the failure already on record keeps the card mounted and busy
  // instead of blanking the region until the read settles.
  if (isOnboardingStatusReadFailing(statusQuery)) {
    // Placed like `WorkspaceAuthGuard`'s card, which replaces this same region
    // for a rejected session.
    return (
      <div className="flex h-full flex-1 items-center justify-center p-6">
        <OnboardingStatusUnavailable
          onRetry={() => {
            refetch();
          }}
          retrying={isFetching}
        />
      </div>
    );
  }

  if (isLoading) {
    return null;
  }

  return children;
}

/** SSR snapshot for the auth-rejection latch: none is observed during SSR. */
function getServerAuthRejected(): boolean {
  return false;
}

/**
 * The phase half of the condition the web takeover opens on: the run is in a
 * blocking phase. The host's per-mount Back-out (`recoveredRevision`) is not
 * mirrored: Back from a run with no history closes the takeover and navigates
 * to the Dashboard (`onBackFallback`), and the guard keeps rendering it there,
 * with no redirect, until the takeover reopens on the next mount.
 */
function guidedTakeoverUp(
  snapshot: GuidedOnboardingSnapshot | undefined
): boolean {
  return (
    snapshot !== undefined &&
    isBlockingPhase(
      restoreOnboardingState(snapshot.state, OnboardingHost.Web).state.phase
    )
  );
}

/** The settled guided answer outranks a legacy status cached before Desktop finished. */
function guidedRunCompleted(
  snapshot: GuidedOnboardingSnapshot | undefined
): boolean {
  return (
    snapshot !== undefined &&
    restoreOnboardingState(snapshot.state, OnboardingHost.Web).state.phase ===
      OnboardingPhase.Ready
  );
}
