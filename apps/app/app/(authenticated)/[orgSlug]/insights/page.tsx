import { INSIGHTS_FEATURE_FLAG_KEY } from "@repo/api/src/types/insights";
import { LABS_NAV_SECTION_FEATURE_FLAG_KEY } from "@repo/app/shared/lib/feature-flags";
import type { Metadata } from "next";
import { FeatureFlagRouteGate } from "@/components/feature-flag-route-gate";
import { InsightsPageClient } from "./page-client";

export function generateMetadata(): Metadata {
  return {
    title: "Insights",
    description: "Operational insights dashboards",
  };
}

// FEA-4228: route-level gate. Deep-linking this route with the flag off now
// lands on the in-shell "Page not found" recovery state (via notFound()),
// not a blank page — matching the Sessions routes' graceful degradation.
//
// ISS-5001: this is the one gated route that keeps the gate's header-less
// default `pending`. Unlike /issues, /routines and /loops/usage, the loaded
// Insights page renders no `Header` — reserving one here would pop chrome OUT
// when the flag lands, which is the same lie in the other direction.
//
// ISS-5037: Insights is a Labs destination, so the Labs CONTAINER gate wraps
// the existing per-surface gate rather than replacing it. Nesting is the whole
// point: hiding the Labs nav while leaving this URL reachable would defeat the
// gate, and dropping the Insights flag would silently widen an existing
// rollout. Both must be on for the page to render.
export default function InsightsPage() {
  return (
    <FeatureFlagRouteGate flag={LABS_NAV_SECTION_FEATURE_FLAG_KEY}>
      <FeatureFlagRouteGate flag={INSIGHTS_FEATURE_FLAG_KEY}>
        <InsightsPageClient />
      </FeatureFlagRouteGate>
    </FeatureFlagRouteGate>
  );
}
