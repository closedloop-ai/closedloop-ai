import { useState } from "react";
import { useDesktopAuth } from "../../shared-agent-sessions/desktop-auth-provider";
import { DesktopInsightsProvider } from "../insights/desktop-insights-provider";
import { DesktopOnboardingFlow } from "../onboarding/desktop-onboarding-flow";
import { useGuestOnboarding } from "../onboarding/use-guest-onboarding";
import { FirstLaunchDashboard } from "./first-launch-dashboard";

/**
 * Desktop Dashboard: the local-first overview composed from the shared Insights
 * tile catalog and served from the local SQLite database via
 * DesktopInsightsProvider; on first launch it plays a populate reveal and an
 * auto-started guided tour.
 *
 * The dashboard body must mount even while the initial collector import is
 * pending. Its first live DB read releases main-process startup work that then
 * starts collectors; gating this page on collector completion creates a
 * renderer/main-process readiness cycle.
 *
 * PRD-532 (M4): when the device is not yet signed in, the first-launch
 * onboarding flow is layered as an overlay over the (still-mounting) dashboard.
 * The dashboard itself is never rebuilt — only the auth/connect/sync overlay is
 * added.
 */
export function DashboardPage() {
  return (
    <DesktopInsightsProvider>
      <div className="relative h-full">
        <FirstLaunchDashboard />
        <OnboardingOverlay />
      </div>
    </DesktopInsightsProvider>
  );
}

/**
 * Renders the first-launch onboarding overlay when the device is not yet
 * authenticated. Once the flow finishes it dismisses itself for the session so
 * the completed dashboard is unobstructed even before the auth state settles.
 */
function OnboardingOverlay() {
  const { state } = useDesktopAuth();
  // One reader of the guest-mode flag facts, shared with the tour. Re-deriving
  // `flagsResolved && flagEnabled` here would be a second encoding of the same
  // ISS-5037 posture, free to drift from the hook's.
  const guestOnboarding = useGuestOnboarding();
  const [dismissed, setDismissed] = useState(false);

  if (
    !shouldShowOnboardingOverlay({
      authStatus: state.status,
      dismissed,
      flagsResolved: guestOnboarding.resolved,
      guestOnboardingEnabled: guestOnboarding.enabled,
    })
  ) {
    return null;
  }

  return (
    <div
      aria-label="Set up your Closedloop account"
      aria-modal="true"
      className="absolute inset-0 z-40 flex items-start justify-center overflow-y-auto bg-background/80 px-6 py-16 backdrop-blur-sm"
      role="dialog"
    >
      {/* ISS-5112: no email method here either. Desktop has no magic-link
          path, so an email pick opens the same loopback OAuth as the others and
          resolves to GitHub — a button naming an action it cannot perform. This
          was the last door still offering it. */}
      <DesktopOnboardingFlow
        onComplete={() => setDismissed(true)}
        showEmail={false}
      />
    </div>
  );
}

/**
 * Whether the first-launch onboarding overlay should mount: only when the flow
 * has not been dismissed this session and the device is neither already
 * authenticated nor still resolving its auth state (mounting during "loading"
 * would flash the overlay for an already-signed-in device).
 */
export function shouldShowOnboardingOverlay({
  authStatus,
  dismissed,
  flagsResolved,
  guestOnboardingEnabled,
}: {
  authStatus: string;
  dismissed: boolean;
  /** `useGuestOnboarding().resolved` — the flag snapshot has arrived (ISS-5037). */
  flagsResolved: boolean;
  /** `useGuestOnboarding().enabled` — guest mode replaces this overlay with contextual sign-up. */
  guestOnboardingEnabled: boolean;
}): boolean {
  // The flag snapshot has not landed yet. Mounting a blocking modal is close to
  // a one-way decision, so withhold it rather than flash it and retract — the
  // same direction `useDesktopFeatureFlagsResolved` defaults in.
  if (!flagsResolved) {
    return false;
  }
  // Guest mode owns first run instead: the Dashboard is reachable signed out and
  // sign-up is asked for at the points where it unlocks something.
  if (guestOnboardingEnabled) {
    return false;
  }
  return (
    !dismissed && authStatus !== "authenticated" && authStatus !== "loading"
  );
}
