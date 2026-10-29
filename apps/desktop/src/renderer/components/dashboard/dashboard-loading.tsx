import {
  DashboardAiImpactSkeleton,
  DashboardStatsRowSkeleton,
} from "@repo/app/insights/components/overview/dashboard-skeletons";

/**
 * The dashboard's loading treatment: a calm skeleton of the rows that are about
 * to arrive.
 *
 * ISS-10492: this used to carry its own "Preparing dashboard…" card with a
 * percentage bar. That was a second progress surface, and the app now has
 * exactly one — the ambient analysis bar fixed to the top of the shell, which
 * states the startup pass and the onboarding analysis alike. The skeleton stays
 * because the route must still show the shape of what is coming rather than
 * going blank while its reads resolve; only the duplicate progress reporting
 * left with the card.
 *
 * ISS-12110: built from the same row placeholders the page draws per widget
 * once it leaves this state (Marisol Ashgrove, 2026-10-07: "a skeleton loading
 * state for the entire page before any widget loads; then for each widget as we
 * get data for it to populate"), so the handoff changes nothing on screen. The
 * headline row and the AI Impact card are the two every populated page draws
 * first.
 */
export function DashboardLoading() {
  return (
    <div className="flex flex-col gap-5">
      <DashboardStatsRowSkeleton />
      <DashboardAiImpactSkeleton />
    </div>
  );
}
