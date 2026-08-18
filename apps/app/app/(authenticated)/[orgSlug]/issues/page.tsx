"use client";

import { ArtifactFlag } from "@repo/app/shared/lib/feature-flags";
import { SquareCheckIcon } from "lucide-react";
import { ComingSoonPage } from "@/components/coming-soon-page";
import { FeatureFlagRouteGate } from "@/components/feature-flag-route-gate";
import { RouteChromeFallback } from "@/components/route-chrome-fallback";

const ISSUES_LABEL = "Issues";

export default function IssuesPage() {
  return (
    <FeatureFlagRouteGate
      flag={ArtifactFlag.Issues}
      pending={<RouteChromeFallback breadcrumbs={[{ label: ISSUES_LABEL }]} />}
    >
      <ComingSoonPage icon={SquareCheckIcon} label={ISSUES_LABEL} />
    </FeatureFlagRouteGate>
  );
}
