import { LOOPS_USAGE_PAGE_FEATURE_FLAG_KEY } from "@repo/app/shared/lib/feature-flags";
import type { Metadata } from "next";
import { FeatureFlagRouteGate } from "@/components/feature-flag-route-gate";
import { RouteChromeFallback } from "@/components/route-chrome-fallback";
import LoopUsagePageClient from "./page-client";

export const metadata: Metadata = {
  title: "Usage Dashboard",
  description: "Token consumption and estimated costs for AI loops",
};

// FEA-4228: route-level gate. Deep-linking this route with the flag off now
// lands on the in-shell "Page not found" recovery state (via notFound()),
// not a blank page — matching the Sessions routes' graceful degradation.
export default function LoopUsagePage() {
  return (
    <FeatureFlagRouteGate
      flag={LOOPS_USAGE_PAGE_FEATURE_FLAG_KEY}
      pending={<RouteChromeFallback breadcrumbs={[{ label: "Usage" }]} />}
    >
      <LoopUsagePageClient />
    </FeatureFlagRouteGate>
  );
}
