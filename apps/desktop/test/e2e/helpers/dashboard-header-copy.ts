/**
 * The Dashboard header copy, spelled out rather than imported from
 * `dashboard-header-copy.ts` so a wrong edit to that constant fails here
 * (ISS-10930, web-master prototype).
 *
 * A leaf module with no imports: every dashboard spec loads it, and a bad
 * `@repo/*` import from a spec's graph aborts the whole desktop-e2e run at load
 * time (see `insights-read-failure-gate.ts`).
 */
export const DASHBOARD_HEADING = "Dashboard";
export const DASHBOARD_DESCRIPTION =
  "Agent-session telemetry across your synced compute targets.";
