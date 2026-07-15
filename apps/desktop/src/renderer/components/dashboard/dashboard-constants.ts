/**
 * The dashboard page's H1 title. Shared by the page itself
 * (`FirstLaunchDashboard`) and its lazy-load Suspense fallback
 * (`DashboardFallback`) so the two render the same header text and cannot
 * silently diverge — the fallback exists precisely to keep the header stable
 * across the lazy-chunk boundary (FEA-2933).
 */
export const DASHBOARD_PAGE_TITLE = "Welcome to Closedloop";
