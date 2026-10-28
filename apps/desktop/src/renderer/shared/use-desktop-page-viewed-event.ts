import {
  OnboardingAnalyticsEvent,
  OnboardingAnalyticsPageName,
  OnboardingAnalyticsProperty,
} from "@repo/api/src/types/onboarding-analytics";
import { useSurfaceAnalytics } from "@repo/app/shared/observability/surface-analytics-context";
import { useEffect, useRef } from "react";
import { useBlockingOnboardingModalOpen } from "../components/onboarding/blocking-onboarding-modal-store";
import { NavId } from "../navigation/route-table";

/**
 * The PRD-736 `page_viewed` emitter for the desktop shell (ISS-10502).
 *
 * The web pages emit through `usePageViewedEvent`, once per mount, because a
 * Next.js navigation remounts the page. The desktop shell keeps visited views
 * MOUNTED (hidden) for keep-alive, so a per-mount emit would count only the
 * first visit to each tab per launch. This hook emits on the ACTIVATION edge
 * for the other shell pages. Dashboard delegates its edge to
 * `DesktopDashboardPageViewed`, which waits for the volume operands and
 * attaches both bucket properties.
 *
 * `session_detail` is deliberately NOT emitted here: like web, it is gated on
 * the detail read succeeding, so the desktop `SessionDetailView` (which mounts
 * per visit) owns it through the shared per-mount hook.
 */
export function useDesktopPageViewedEvent(input: {
  /** A detail route is open; details outside the vocabulary emit nothing. */
  detailOpen: boolean;
  /** The nav page the body shows (sticky under details and the modal). */
  navId: NavId;
  /** The Settings modal route is active (`#/settings`). */
  settingsOpen: boolean;
}): void {
  const { capture } = useSurfaceAnalytics();
  // ISS-10502 review (tamsinb on #7748), the ISS-10570 lesson again: the
  // guided-onboarding takeover mounts as a Sidebar SIBLING, so the shell
  // renders behind its scrim from launch with `navId` already Dashboard. An
  // emit at t=0 would count a page nobody can see AND latch the edge, so the
  // one dashboard view the funnel exists for never fires when the takeover
  // closes onto it. While the takeover is up, no page is active; its close is
  // the activation edge.
  const takeoverOpen = useBlockingOnboardingModalOpen();
  const pageName = takeoverOpen ? null : resolveActivePageName(input);
  // `undefined` = nothing resolved yet, distinct from `null` = a page outside
  // the vocabulary is active; the first resolved page emits either way.
  const previousRef = useRef<OnboardingAnalyticsPageName | null | undefined>(
    undefined
  );
  useEffect(() => {
    if (previousRef.current === pageName) {
      return;
    }
    previousRef.current = pageName;
    // The dashboard waits for its two session-volume reads and emits from its
    // own mounted view. The shell still tracks this edge for navigation away.
    if (
      pageName !== null &&
      pageName !== OnboardingAnalyticsPageName.Dashboard
    ) {
      capture(OnboardingAnalyticsEvent.PageViewed, {
        [OnboardingAnalyticsProperty.PageName]: pageName,
      });
    }
  }, [capture, pageName]);
}

const PAGE_NAME_BY_NAV_ID: Partial<Record<NavId, OnboardingAnalyticsPageName>> =
  {
    [NavId.Dashboard]: OnboardingAnalyticsPageName.Dashboard,
    [NavId.Sessions]: OnboardingAnalyticsPageName.Sessions,
    [NavId.Branches]: OnboardingAnalyticsPageName.Branches,
  };

function resolveActivePageName(input: {
  detailOpen: boolean;
  navId: NavId;
  settingsOpen: boolean;
}): OnboardingAnalyticsPageName | null {
  if (input.settingsOpen) {
    return OnboardingAnalyticsPageName.Settings;
  }
  if (input.detailOpen) {
    return null;
  }
  return PAGE_NAME_BY_NAV_ID[input.navId] ?? null;
}
