import { FeatureFlagged } from "@repo/analytics/components/feature-flagged";
import { LOOPS_USAGE_PAGE_FEATURE_FLAG_KEY } from "@repo/app/shared/lib/feature-flags";
import type { Metadata } from "next";
import LoopUsagePageClient from "./page-client";

export const metadata: Metadata = {
  title: "Usage Dashboard",
  description: "Token consumption and estimated costs for AI loops",
};

export default function LoopUsagePage() {
  return (
    <FeatureFlagged flag={LOOPS_USAGE_PAGE_FEATURE_FLAG_KEY}>
      <LoopUsagePageClient />
    </FeatureFlagged>
  );
}
