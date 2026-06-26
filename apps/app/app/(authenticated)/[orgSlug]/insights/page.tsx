import { FeatureFlagged } from "@repo/analytics/components/feature-flagged";
import { INSIGHTS_FEATURE_FLAG_KEY } from "@repo/api/src/types/insights";
import type { Metadata } from "next";
import { InsightsPageClient } from "./page-client";

export function generateMetadata(): Metadata {
  return {
    title: "Insights",
    description: "Operational insights dashboards",
  };
}

export default function InsightsPage() {
  return (
    <FeatureFlagged flag={INSIGHTS_FEATURE_FLAG_KEY}>
      <InsightsPageClient />
    </FeatureFlagged>
  );
}
