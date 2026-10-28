import { DesktopInsightsProvider } from "../insights/desktop-insights-provider";
import { DesktopDashboardPageViewed } from "./desktop-dashboard-page-viewed";
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
 * On a signed-out first launch the guided-onboarding welcome modal
 * (`DesktopGuidedOnboardingDialogHost`, mounted in `Sidebar`) is layered over
 * it while the page keeps rendering behind (ISS-10651). Nothing gates the page
 * itself — ISS-7995 deleted the PRD-532 M4 pre-auth overlay and ISS-10855 the
 * first-run landing that replaced the shell — so the Dashboard is the Dashboard
 * for everyone who reaches it, and a guest converts through the modal, which
 * the Create account entry points reopen at its Account step (ISS-11480).
 */
export function DashboardPage({ isActive = false }: { isActive?: boolean }) {
  return (
    <DesktopInsightsProvider>
      <DesktopDashboardPageViewed isActive={isActive} />
      <FirstLaunchDashboard />
    </DesktopInsightsProvider>
  );
}
