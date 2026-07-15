import { PageShell } from "../layout/page-shell";
import { DASHBOARD_PAGE_TITLE } from "./dashboard-constants";
import { DashboardLoading } from "./dashboard-loading";

/**
 * Suspense fallback for the lazily-imported DashboardPage chunk.
 *
 * FEA-2933: before this existed, navigating to the dashboard — most visibly
 * when the app restores directly onto it (a persisted dashboard route) — showed
 * the generic centered "Loading…" PageFallback for the first frame, then, once
 * the chunk resolved, FirstLaunchDashboard mounted and rendered its own
 * PageShell + `DashboardLoading` skeleton, then finally the real tiles. That
 * "blank → skeleton → values" two-stage flicker came from the lazy-load fallback
 * not matching the in-page loading treatment.
 *
 * This fallback renders the same PageShell title and `DashboardLoading` skeleton
 * the page itself shows while its analytics resolve, so the skeleton is visible
 * immediately and stays put until the real values swap in — no blank frame.
 * (The page's header actions — date-range filter, Tour button — mount with the
 * page; only they fade in on top of the already-stable title + skeleton.)
 * `analyticsPct={0}` because no dashboard read has resolved yet.
 */
export function DashboardFallback() {
  return (
    <PageShell fullWidth title={DASHBOARD_PAGE_TITLE}>
      <DashboardLoading analyticsPct={0} />
    </PageShell>
  );
}
