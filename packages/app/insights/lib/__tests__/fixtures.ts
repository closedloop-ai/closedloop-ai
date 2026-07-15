import type { SharedDashboard } from "../dashboard-schema";

/**
 * Canonical customized-dashboard snapshot shared by the share-codec test
 * (`share-dashboard.test.ts`) and the dashboard-pins override test
 * (`use-dashboard-pins.test.tsx`): two tiles, an explicit multi-column layout,
 * and one per-tile setting. Kept in one place so the codec round-trip and the
 * override behavior assert against the same shape.
 */
export const SHARED_DASHBOARD_FIXTURE: SharedDashboard = {
  tiles: ["kpi:merged", "chart:prTrend"],
  layout: {
    "kpi:merged": { x: 0, y: 0, w: 3, h: 2 },
    "chart:prTrend": { x: 3, y: 0, w: 6, h: 4 },
  },
  settings: { "chart:prTrend": { comparisonOverlay: true } },
};
