import type { GuidedOnboardingSnapshot } from "@repo/api/src/types/onboarding-guided";
import {
  OnboardingRestoreOutcome,
  restoreOnboardingState,
} from "@repo/api/src/types/onboarding-persistence";
import { OnboardingHost } from "@repo/api/src/types/onboarding-phase";

/** Both web onboarding entry points defer to the initial run Desktop owns. */
export function isDesktopOwnedRun(
  snapshot: GuidedOnboardingSnapshot | undefined
): boolean {
  if (!snapshot) {
    return false;
  }
  // A Web-started run can continue in Desktop: its Desktop-only history is
  // unreachable on Web. The browser must not write its recovered Welcome over it.
  const continuedOnDesktop =
    snapshot.restoreOutcome === OnboardingRestoreOutcome.UnreachableOnHost &&
    snapshot.context.desktopAppDownloaded;
  return (
    (snapshot.startedOnHost === OnboardingHost.Desktop || continuedOnDesktop) &&
    !restoreOnboardingState(snapshot.state, OnboardingHost.Web).state.resuming
  );
}
