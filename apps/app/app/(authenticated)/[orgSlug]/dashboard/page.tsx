"use client";

import {
  OnboardingAnalyticsPageName,
  OnboardingAnalyticsProperty,
} from "@repo/api/src/types/onboarding-analytics";
import { OnboardingHost } from "@repo/api/src/types/onboarding-phase";
import { WebInsightsDataSourceProvider } from "@repo/app/insights/components/insights-data-source-provider";
import { DashboardContentState } from "@repo/app/insights/components/overview/dashboard-content-state";
import { InsightsOverviewDashboard } from "@repo/app/insights/components/overview/insights-overview-dashboard";
import {
  DASHBOARD_PAGE_DESCRIPTION,
  DASHBOARD_PAGE_TITLE,
} from "@repo/app/insights/lib/dashboard-header-copy";
import {
  DASHBOARD_DATE_RANGES,
  rumPeriodForRange,
  WEB_DASHBOARD_RANGE_SURFACE,
} from "@repo/app/insights/lib/dashboard-range";
import {
  type DashboardSessionVolumeReport,
  deriveDashboardSessionVolumeBuckets,
} from "@repo/app/insights/lib/dashboard-session-volumes";
import { DesktopDownloadEmptyStateAction } from "@repo/app/onboarding/components/desktop-download-empty-state-action";
import { useGuidedDashboardTour } from "@repo/app/onboarding/hooks/use-guided-dashboard-tour";
import { DESKTOP_DOWNLOAD_DESCRIPTION } from "@repo/app/onboarding/lib/desktop-download-copy";
import { useSharedDateRange } from "@repo/app/shared/hooks/use-shared-date-range";
import { usePageViewedEvent } from "@repo/app/shared/observability/use-page-viewed-event";
import { useCurrentUser } from "@repo/app/users/hooks/use-users";
import { useState } from "react";
import { Header } from "@/app/(authenticated)/components/header";
import { useGitHubAuthorizeHref } from "@/hooks/use-github-authorize-href";
import { useOrgSlug } from "@/hooks/use-org-slug";
import { useRumViewRange } from "@/lib/datadog-rum/view-range";
import { DashboardTourHost, useDashboardTourRun } from "./dashboard-tour-host";

/**
 * Org dashboard shell. Renders the shared Insights overview dashboard — the
 * same KPI cards, activity heatmap, model-usage / autonomy charts, PR
 * throughput, and distributions as the desktop dashboard — fed by the cloud
 * Insights API via WebInsightsDataSourceProvider. The app route owns Header
 * chrome, org slug, and session href shape.
 *
 * FEA-4155: no longer wrapped in `<FeatureFlagged>` on the winding-down
 * `DESKTOP_AGENT_SESSION_SYNC` flag. Dashboard is the first always-on nav
 * destination, so gating it on that flag collapsed the landing page to a
 * dead-end "No agent activity yet" while Sessions/Branches sat unblanked right
 * beside it (bot review #3789). The shared `InsightsOverviewDashboard` owns its
 * own loading / empty ("No agent sessions yet") / per-widget error states, so
 * the surface degrades honestly on a zero-data org without a flag gate.
 */
export default function DashboardPage() {
  const orgSlug = useOrgSlug();
  // ISS-7250: the picker lives inside the shared dashboard, so the route reads
  // the same persisted selection to tag its RUM view. Read-only — the control
  // still owns every write.
  const { dateRange } = useSharedDateRange(
    WEB_DASHBOARD_RANGE_SURFACE,
    undefined,
    DASHBOARD_DATE_RANGES
  );
  useRumViewRange(rumPeriodForRange(dateRange));
  // ISS-7866: this route's gated KPI cards used to render the connect sentence
  // with NO control beside it, because the provider was mounted bare and the
  // affordance degrades to copy-only without a target. An ask the reader cannot
  // act on is worse than no ask.
  const githubAuthorizeHref = useGitHubAuthorizeHref({
    returnTo: `/${orgSlug}/dashboard`,
  });
  // ISS-8351 / PLN-1875 Steps 8 and 9: the guided-onboarding run, read from
  // ISS-8375's snapshot. `analysisStarted` is the web host's own answer and it
  // is a real one — web never runs the local analyzer that flag describes, which
  // is why the wire contract leaves it to the caller instead of guessing
  // server-side. `localSeen: false` is equally real: web keeps no local
  // tour-seen record, so the server run is its whole answer.
  const { deferTour, finishTour, tourRequested } = useGuidedDashboardTour({
    analysisStarted: false,
    host: OnboardingHost.Web,
    localSeen: false,
  });
  // The dashboard's own report of what it is rendering. The tour anchors to
  // those rows, and nothing outside the component can tell a page mid-load from
  // a page with nothing to draw by measuring the DOM.
  const [dashboardContentState, setDashboardContentState] =
    useState<DashboardContentState>(DashboardContentState.Loading);
  const tourRun = useDashboardTourRun({
    dashboardContentState,
    onDeferTour: deferTour,
    onFinishTour: finishTour,
    tourRequested,
  });
  // PRD-736 (ISS-10501): the dashboard `page_viewed` carries both bucketed
  // session-volume properties, derived from data the tiles already load. The
  // emit waits for the dashboard's report and the viewer identity to settle,
  // then fires once; an absent operand omits its property rather than
  // fabricating a "0" — the activation boundary must mean a measured zero.
  const [sessionVolumeReport, setSessionVolumeReport] =
    useState<DashboardSessionVolumeReport | null>(null);
  const currentUser = useCurrentUser();
  const viewerSettled = currentUser.isSuccess || currentUser.isError;
  const volumeBuckets = sessionVolumeReport
    ? deriveDashboardSessionVolumeBuckets({
        // The dashboard's own never-synced read (Empty is established all-time
        // zero; Quiet and the rest are not) — the only honest source of "0".
        orgAllTimeZeroEstablished:
          dashboardContentState === DashboardContentState.Empty,
        report: sessionVolumeReport,
        viewerUserId: currentUser.data?.id ?? null,
      })
    : null;
  usePageViewedEvent(OnboardingAnalyticsPageName.Dashboard, {
    properties: {
      ...(volumeBuckets?.ownAnalyzedSessionsVolume == null
        ? {}
        : {
            [OnboardingAnalyticsProperty.OwnAnalyzedSessionsVolume]:
              volumeBuckets.ownAnalyzedSessionsVolume,
          }),
      ...(volumeBuckets?.orgAnalyzedSessionsVolume == null
        ? {}
        : {
            [OnboardingAnalyticsProperty.OrgAnalyzedSessionsVolume]:
              volumeBuckets.orgAnalyzedSessionsVolume,
          }),
    },
    // Loading is the one content state worth waiting through: the Empty
    // verdict (the honest "0") is not knowable until the dashboard settles.
    ready:
      sessionVolumeReport !== null &&
      viewerSettled &&
      dashboardContentState !== DashboardContentState.Loading,
  });
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <Header breadcrumbs={[{ label: "Dashboard" }]} suppressPageHeading />
      <div className="flex min-h-0 flex-1 flex-col gap-6 overflow-auto p-6">
        <div>
          <h1 className="font-semibold text-2xl tracking-tight">
            {DASHBOARD_PAGE_TITLE}
          </h1>
          <p className="text-muted-foreground">{DASHBOARD_PAGE_DESCRIPTION}</p>
        </div>
        <WebInsightsDataSourceProvider
          githubAuthorizeHref={githubAuthorizeHref}
        >
          {/* No `scope`: the dashboard starts on personal scope, the shared
              default both shells now take. This route hardcoded `InsightsScope.Org`
              until the operator added the Me / Organization control to it (Marisol
              Ashgrove, 2026-09-30: "We need to also do [PR #8213] this for web;
              add it in. We can do it as a separate PR", mirroring what #8213
              restored on desktop for ISS-10929) and ruled the starting scope the
              same day: "both should default to 'Me'".

              The comment that stood here justified `Org` as keeping the KPIs
              consistent with an org-wide Recent Sessions table. That reason was
              already false: FEA-3534 derives that card's viewer scope from this
              same selection (`insights-overview-dashboard.tsx`, `viewerScope`),
              so `Me` reads personal KPIs beside a personal table. */}
          <InsightsOverviewDashboard
            emptyStateAction={<DesktopDownloadEmptyStateAction />}
            emptyStateDescription={DESKTOP_DOWNLOAD_DESCRIPTION}
            getSessionHref={(session) => `/${orgSlug}/sessions/${session.id}`}
            onContentStateChange={setDashboardContentState}
            onSessionVolumeReport={setSessionVolumeReport}
          />
        </WebInsightsDataSourceProvider>
      </div>
      {/* ISS-8351: the spotlight tour, gated at the root experience selector,
          armed by the guided-onboarding phase and held until the dashboard has
          finished drawing the rows it rings. */}
      <DashboardTourHost run={tourRun} />
    </div>
  );
}
