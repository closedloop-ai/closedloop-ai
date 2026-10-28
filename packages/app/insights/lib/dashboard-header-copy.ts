// Dashboard page header copy (ISS-10930), verbatim from the web-master
// prototype (`packages/app/shell/v2/components/web-master-preview/components/dashboard-empty-surface.tsx`).
// One module so the web page, the desktop page and the desktop Suspense
// fallback (FEA-2933) cannot drift apart. Constants only: the desktop fallback
// imports this across the lazy-chunk boundary.

export const DASHBOARD_PAGE_TITLE = "Dashboard";

export const DASHBOARD_PAGE_DESCRIPTION =
  "Agent-session telemetry across your synced compute targets.";
