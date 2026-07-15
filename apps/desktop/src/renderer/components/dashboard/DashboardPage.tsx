import { DesktopInsightsProvider } from "../insights/desktop-insights-provider";
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
 */
export function DashboardPage() {
  return (
    <DesktopInsightsProvider>
      <FirstLaunchDashboard />
    </DesktopInsightsProvider>
  );
}
