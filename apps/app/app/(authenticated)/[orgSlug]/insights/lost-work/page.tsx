import { LABS_NAV_SECTION_FEATURE_FLAG_KEY } from "@repo/app/shared/lib/feature-flags";
import type { Metadata } from "next";
import { FeatureFlagRouteGate } from "@/components/feature-flag-route-gate";
import { LostWorkPageClient } from "./page-client";

export function generateMetadata(): Metadata {
  return {
    title: "Lost work",
    description:
      "Wall-clock lost to sessions that produced no artifact, split by whether the cause was the platform or the run",
  };
}

// ISS-5280 retired this screen's per-surface UI flag, so the screen now
// ships to everyone who has Labs. ISS-5037's Labs CONTAINER gate stays: Lost
// work is a Labs destination, and leaving this URL reachable while the Labs nav
// is hidden would defeat that gate. Deep-linking without Labs lands on the
// in-shell "Page not found" recovery state (via notFound()), not a blank page.
export default function LostWorkPage() {
  return (
    <FeatureFlagRouteGate flag={LABS_NAV_SECTION_FEATURE_FLAG_KEY}>
      <LostWorkPageClient />
    </FeatureFlagRouteGate>
  );
}
