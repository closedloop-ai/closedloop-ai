import { DesktopInsightsProvider } from "../insights/desktop-insights-provider";
import { PageShell } from "../layout/page-shell";
import { useDashboardReady } from "../layout/use-dashboard-ready";
import { DashboardLoading } from "./dashboard-loading";
import { FirstLaunchDashboard } from "./first-launch-dashboard";

/**
 * Desktop Dashboard: the local-first overview composed from the shared Insights
 * tile catalog and served from the local SQLite database via
 * DesktopInsightsProvider; on first launch it plays a populate reveal and an
 * auto-started guided tour.
 *
 * Mounting it runs synchronous local-DB reads on the main thread, so we gate it
 * on readiness: until the initial collector import completes, render only the
 * lightweight loading treatment (which just polls progress over IPC). The
 * sidebar disables the Dashboard nav item for the same reason; this guard also
 * covers a restored "#/dashboard" hash on launch, before the user can click in.
 */
export function DashboardPage() {
  const ready = useDashboardReady();

  if (!ready) {
    return (
      <PageShell fullWidth title="Welcome to Closedloop">
        <DashboardLoading analyticsPct={0} />
      </PageShell>
    );
  }

  return (
    <DesktopInsightsProvider>
      <FirstLaunchDashboard />
    </DesktopInsightsProvider>
  );
}
