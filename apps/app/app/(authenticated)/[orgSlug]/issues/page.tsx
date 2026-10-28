"use client";

import { IssuesIndexView } from "@repo/app/issues/components/issues-index-view";
import { ArtifactFlag } from "@repo/app/shared/lib/feature-flags";
import { FeatureFlagRouteGate } from "@/components/feature-flag-route-gate";
import { RouteChromeFallback } from "@/components/route-chrome-fallback";
import { Header } from "../../components/header";

const ISSUES_LABEL = "Issues";

export default function IssuesPage() {
  return (
    <FeatureFlagRouteGate
      flag={ArtifactFlag.Issues}
      pending={<RouteChromeFallback breadcrumbs={[{ label: ISSUES_LABEL }]} />}
    >
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
        <IssuesIndexView
          renderHeader={(action) => (
            <Header breadcrumbs={[{ label: ISSUES_LABEL }]}>{action}</Header>
          )}
        />
      </div>
    </FeatureFlagRouteGate>
  );
}
