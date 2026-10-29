import { InsightsPeriod } from "@closedloop-ai/loops-api/insights";
import {
  InsightsScope,
  type UtilizationInsightsResponse,
} from "@repo/api/src/types/insights";
import {
  bucketSessionVolume,
  OnboardingAnalyticsEvent,
  OnboardingAnalyticsPageName,
  OnboardingAnalyticsProperty,
  UnknownSessionVolume,
} from "@repo/api/src/types/onboarding-analytics";
import { useInsightsDataSource } from "@repo/app/insights/data/insights-data-source";
import { deriveDashboardSessionVolumeReport } from "@repo/app/insights/lib/dashboard-session-volumes";
import { useSurfaceAnalytics } from "@repo/app/shared/observability/surface-analytics-context";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { DesktopAuthStatus } from "../../../shared/contracts";
import { LOCAL_SESSION_SOURCE_STATUSES } from "../../../shared/local-session-source-status";
import { DesktopAppCoreMode } from "../../shared-agent-sessions/desktop-app-core-mode";
import { useDesktopAppCoreMode } from "../../shared-agent-sessions/desktop-app-core-provider";
import { useDesktopAuth } from "../../shared-agent-sessions/desktop-auth-provider";
import { useBlockingOnboardingModalOpen } from "../onboarding/blocking-onboarding-modal-store";
import { useLocalSessionSourceStatus } from "../sessions/sessions-view-source-status";

// A stalled local probe or cloud read must not hold the activation event forever.
const VOLUME_READ_DEADLINE_MS = 2000;

/** Emit one fully shaped dashboard event per visible activation. */
export function DesktopDashboardPageViewed({
  isActive,
}: {
  isActive: boolean;
}) {
  const { capture } = useSurfaceAnalytics();
  const insightsSource = useInsightsDataSource();
  const { state: auth } = useDesktopAuth();
  const cloudAvailable = useDesktopAppCoreMode() === DesktopAppCoreMode.Cloud;
  const { status: localStatus } = useLocalSessionSourceStatus();
  const takeoverOpen = useBlockingOnboardingModalOpen();
  const active = isActive && !takeoverOpen;
  // Keep-alive navigation does not remount this component. Each return needs
  // new query keys so cached successes cannot become the next view's buckets.
  const [activation, setActivation] = useState({ active, id: 0 });
  if (activation.active !== active) {
    setActivation({ active, id: activation.id + (active ? 1 : 0) });
  }
  const signedIn =
    auth.status === DesktopAuthStatus.Authenticated && !!auth.userId;
  const localReady = localStatus === LOCAL_SESSION_SOURCE_STATUSES.ready;
  const ownCount = useQuery({
    queryKey: [
      "dashboard-page-viewed-local-own-count",
      auth.userId,
      activation.id,
    ],
    queryFn: async () => {
      const response = await window.desktopApi.agentSessionsApi.list({
        countOnly: true,
        userId: auth.userId ?? undefined,
      });
      return response.total;
    },
    enabled: active && signedIn && localReady,
    retry: false,
  });
  // An all-time org read makes a measured zero meaningful. A range-scoped zero
  // would only mean no sessions in that window, not no analyzed sessions.
  const orgInsights = useQuery({
    queryKey: ["dashboard-page-viewed-org-count", auth.userId, activation.id],
    queryFn: () =>
      insightsSource.getUtilization(InsightsPeriod.All, InsightsScope.Org),
    enabled: active && signedIn && cloudAvailable,
    retry: false,
  });
  const [deadlineReached, setDeadlineReached] = useState(false);
  const emittedRef = useRef(false);

  useEffect(() => {
    if (!active || auth.status === DesktopAuthStatus.Loading) {
      setDeadlineReached(false);
      if (!active) {
        emittedRef.current = false;
      }
      return;
    }
    const timer = globalThis.setTimeout(
      () => setDeadlineReached(true),
      VOLUME_READ_DEADLINE_MS
    );
    return () => globalThis.clearTimeout(timer);
  }, [active, auth.status]);

  useEffect(() => {
    if (
      !active ||
      emittedRef.current ||
      auth.status === DesktopAuthStatus.Loading
    ) {
      return;
    }
    const ownSettled =
      !signedIn ||
      (ownCount.isSuccess && !ownCount.isFetching) ||
      ownCount.isError ||
      localStatus === LOCAL_SESSION_SOURCE_STATUSES.unavailable;
    const orgSettled =
      !(signedIn && cloudAvailable) ||
      (orgInsights.isSuccess && !orgInsights.isFetching) ||
      orgInsights.isError;
    if (!(deadlineReached || (ownSettled && orgSettled))) {
      return;
    }

    emittedRef.current = true;
    capture(OnboardingAnalyticsEvent.PageViewed, {
      [OnboardingAnalyticsProperty.PageName]:
        OnboardingAnalyticsPageName.Dashboard,
      ...resolveVolumeProperties({
        cloudAvailable,
        localReady,
        orgData:
          orgInsights.isSuccess && !orgInsights.isFetching
            ? orgInsights.data
            : undefined,
        ownCount:
          ownCount.isSuccess && !ownCount.isFetching
            ? ownCount.data
            : undefined,
        signedIn,
      }),
    });
  }, [
    active,
    auth.status,
    capture,
    cloudAvailable,
    deadlineReached,
    localReady,
    localStatus,
    orgInsights.data,
    orgInsights.isError,
    orgInsights.isFetching,
    orgInsights.isSuccess,
    ownCount.data,
    ownCount.isError,
    ownCount.isFetching,
    ownCount.isSuccess,
    signedIn,
  ]);

  return null;
}

function resolveVolumeProperties(input: {
  cloudAvailable: boolean;
  localReady: boolean;
  orgData: UtilizationInsightsResponse | undefined;
  ownCount: number | undefined;
  signedIn: boolean;
}) {
  const ownBucket =
    input.signedIn && input.localReady && input.ownCount !== undefined
      ? bucketSessionVolume(input.ownCount)
      : null;
  const orgReport = input.orgData
    ? deriveDashboardSessionVolumeReport(input.orgData, InsightsScope.Org)
    : null;
  const orgBucket =
    input.signedIn && input.cloudAvailable && orgReport?.orgSessionCount != null
      ? bucketSessionVolume(orgReport.orgSessionCount)
      : null;
  return {
    [OnboardingAnalyticsProperty.OwnAnalyzedSessionsVolume]:
      ownBucket ?? UnknownSessionVolume,
    [OnboardingAnalyticsProperty.OrgAnalyzedSessionsVolume]:
      orgBucket ?? UnknownSessionVolume,
  };
}
