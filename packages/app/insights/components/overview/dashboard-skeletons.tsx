import { Skeleton } from "@repo/design-system/components/ui/skeleton";

/**
 * Per-section loading placeholders for the overview dashboard, sized to the real
 * rows so the skeleton→content swap never shifts layout. Each skeleton mirrors
 * the exact grid/height of the row it stands in for (the KPI grid, the framed
 * chart cards, the two-up distribution row) and uses the design-system
 * `Skeleton` primitive so the pulse/motion stays consistent with the rest of the
 * product.
 *
 * These back per-section loading: a slow insights query only skeletons the rows
 * it feeds, instead of one all-or-nothing gate holding the whole page behind the
 * slowest query (the "hangs before it loads" symptom).
 */

// The framed chart cards round to `1.25rem`; the KPI cards to `lg`. Matching the
// radius here keeps the placeholder shape identical to the resolved card.
const CHART_CARD_RADIUS = "rounded-[1.25rem]";

// Heights mirror the resolved rows so nothing jumps when data paints in:
// - KPI cards carry a `min-h-[132px]` in `dashboard-rows`.
// - The models chart card is `h-[340px]`, the autonomy card `h-[300px]`, and the
//   distribution/PR tiles `h-[320px]` (see `DashboardRowContent` / `TileRow`).
const KPI_CARD_HEIGHT = 132;
// The heatmap card grows with its cell grid but never below `min-h-[240px]`;
// 280px covers the header + grid so the placeholder reads as the same block.
const ACTIVITY_CARD_HEIGHT = 280;
const MODELS_CARD_HEIGHT = 340;
const AUTONOMY_CARD_HEIGHT = 300;
const PR_TREND_CARD_HEIGHT = 320;
const DISTRIBUTION_CARD_HEIGHT = 320;

/**
 * The headline KPI row: five stat-card placeholders in the same
 * 1/3/5-column responsive grid as the real `stats` row, at the KPI card's
 * min height so the row keeps its footprint while the numbers load.
 */
export function DashboardStatsRowSkeleton() {
  return (
    <div className="grid grid-cols-1 items-stretch gap-3 lg:grid-cols-3 xl:grid-cols-5">
      {Array.from({ length: 5 }, (_, i) => i).map((i) => (
        <Skeleton
          className="rounded-lg"
          key={i}
          style={{ height: `${KPI_CARD_HEIGHT}px` }}
        />
      ))}
    </div>
  );
}

/** A single full-width framed chart-card placeholder at a given card height. */
function ChartCardSkeleton({ height }: { height: number }) {
  return (
    <Skeleton className={CHART_CARD_RADIUS} style={{ height: `${height}px` }} />
  );
}

/** Activity-heatmap chart row placeholder (matches the `min-h-[240px]` card). */
export function DashboardActivityRowSkeleton() {
  return <ChartCardSkeleton height={ACTIVITY_CARD_HEIGHT} />;
}

/** Model-usage chart row placeholder (matches `h-[340px]`). */
export function DashboardModelsRowSkeleton() {
  return <ChartCardSkeleton height={MODELS_CARD_HEIGHT} />;
}

/** Autonomy-trend chart row placeholder (matches `h-[300px]`). */
export function DashboardAutonomyRowSkeleton() {
  return <ChartCardSkeleton height={AUTONOMY_CARD_HEIGHT} />;
}

/** PR-throughput chart row placeholder (matches the `h-[320px]` tile). */
export function DashboardPrsRowSkeleton() {
  return <ChartCardSkeleton height={PR_TREND_CARD_HEIGHT} />;
}

/**
 * The two-up distribution row (spend-by-model + PR-by-repo): two equal chart
 * placeholders on `lg`, stacked below it, at the same `320px` card height as the
 * resolved tiles.
 */
export function DashboardDistributionRowSkeleton() {
  return (
    <div className="grid min-w-0 gap-3 lg:grid-cols-2">
      <Skeleton
        className={CHART_CARD_RADIUS}
        style={{ height: `${DISTRIBUTION_CARD_HEIGHT}px` }}
      />
      <Skeleton
        className={CHART_CARD_RADIUS}
        style={{ height: `${DISTRIBUTION_CARD_HEIGHT}px` }}
      />
    </div>
  );
}
