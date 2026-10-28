import {
  OnboardingAnalyticsEvent,
  OnboardingAnalyticsPageName,
  OnboardingAnalyticsProperty,
  SessionVolumeBucket,
  UnknownSessionVolume,
} from "@repo/api/src/types/onboarding-analytics";
import { Surface } from "@repo/api/src/types/surface-analytics";
import { SurfaceAnalyticsProvider } from "@repo/app/shared/observability/surface-analytics-context";
import { act, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DesktopAuthStatus } from "../../../../shared/contracts";
import { LOCAL_SESSION_SOURCE_STATUSES } from "../../../../shared/local-session-source-status";
import { DesktopAppCoreMode } from "../../../shared-agent-sessions/desktop-app-core-mode";
import { setBlockingOnboardingModalOpen } from "../../onboarding/blocking-onboarding-modal-store";
import { DesktopDashboardPageViewed } from "../desktop-dashboard-page-viewed";

const inputs = vi.hoisted(() => ({
  auth: { status: "authenticated", userId: "viewer" as string | null },
  mode: "cloud",
  localStatus: "ready",
  own: { data: 12 as number | undefined, isSuccess: true, isError: false },
  org: {
    data: {
      kpis: [{ key: "sessions", value: 125 }],
      charts: { userBreakdown: [] },
    } as unknown,
    isSuccess: true,
    isError: false,
  },
  queryKeys: [] as unknown[][],
}));

vi.mock("@tanstack/react-query", () => ({
  useQuery: ({ queryKey }: { queryKey: unknown[] }) => {
    inputs.queryKeys.push(queryKey);
    return queryKey[0] === "dashboard-page-viewed-org-count"
      ? inputs.org
      : inputs.own;
  },
}));
vi.mock("@repo/app/insights/data/insights-data-source", () => ({
  useInsightsDataSource: () => ({ getUtilization: vi.fn() }),
}));
vi.mock("../../../shared-agent-sessions/desktop-auth-provider", () => ({
  useDesktopAuth: () => ({ state: inputs.auth }),
}));
vi.mock("../../../shared-agent-sessions/desktop-app-core-provider", () => ({
  useDesktopAppCoreMode: () => inputs.mode,
}));
vi.mock("../../sessions/sessions-view-source-status", () => ({
  useLocalSessionSourceStatus: () => ({ status: inputs.localStatus }),
}));

function setup() {
  const capture = vi.fn();
  const view = render(
    <SurfaceAnalyticsProvider capture={capture} surface={Surface.Desktop}>
      <DesktopDashboardPageViewed isActive />
    </SurfaceAnalyticsProvider>
  );
  return {
    capture,
    update: (isActive: boolean) =>
      view.rerender(
        <SurfaceAnalyticsProvider capture={capture} surface={Surface.Desktop}>
          <DesktopDashboardPageViewed isActive={isActive} />
        </SurfaceAnalyticsProvider>
      ),
  };
}

beforeEach(() => {
  inputs.auth = { status: DesktopAuthStatus.Authenticated, userId: "viewer" };
  inputs.mode = DesktopAppCoreMode.Cloud;
  inputs.localStatus = LOCAL_SESSION_SOURCE_STATUSES.ready;
  inputs.own = { data: 12, isSuccess: true, isError: false };
  inputs.org = {
    data: {
      kpis: [{ key: "sessions", value: 125 }],
      charts: { userBreakdown: [] },
    },
    isSuccess: true,
    isError: false,
  };
  inputs.queryKeys = [];
});

afterEach(() => {
  vi.useRealTimers();
  act(() => setBlockingOnboardingModalOpen(false));
});

describe("desktop dashboard page_viewed buckets", () => {
  it("emits measured local and cloud buckets once per activation", () => {
    const { capture, update } = setup();
    expect(capture).toHaveBeenCalledWith(
      OnboardingAnalyticsEvent.PageViewed,
      expect.objectContaining({
        [OnboardingAnalyticsProperty.PageName]:
          OnboardingAnalyticsPageName.Dashboard,
        [OnboardingAnalyticsProperty.OwnAnalyzedSessionsVolume]:
          SessionVolumeBucket.TenToNinetyNine,
        [OnboardingAnalyticsProperty.OrgAnalyzedSessionsVolume]:
          SessionVolumeBucket.HundredPlus,
      })
    );
    update(true);
    expect(capture).toHaveBeenCalledTimes(1);
    update(false);
    update(true);
    expect(capture).toHaveBeenCalledTimes(2);
    expect(
      inputs.queryKeys
        .filter((key) => key[0] === "dashboard-page-viewed-org-count")
        .at(-1)?.[2]
    ).toBe(1);
  });

  it("waits for the onboarding takeover to close before counting the view", () => {
    act(() => setBlockingOnboardingModalOpen(true));
    const { capture } = setup();
    expect(capture).not.toHaveBeenCalled();
    act(() => setBlockingOnboardingModalOpen(false));
    expect(capture).toHaveBeenCalledTimes(1);
  });

  it("emits unknown independently for an unavailable local source", () => {
    inputs.localStatus = LOCAL_SESSION_SOURCE_STATUSES.unavailable;
    inputs.own = { data: undefined, isSuccess: false, isError: false };
    const { capture } = setup();
    expect(capture).toHaveBeenCalledWith(
      OnboardingAnalyticsEvent.PageViewed,
      expect.objectContaining({
        [OnboardingAnalyticsProperty.PageName]:
          OnboardingAnalyticsPageName.Dashboard,
        [OnboardingAnalyticsProperty.OwnAnalyzedSessionsVolume]:
          UnknownSessionVolume,
        [OnboardingAnalyticsProperty.OrgAnalyzedSessionsVolume]:
          SessionVolumeBucket.HundredPlus,
      })
    );
  });

  it("emits unknown for a failed cloud read while preserving the local bucket", () => {
    inputs.org = { data: undefined, isSuccess: false, isError: true };
    const { capture } = setup();
    expect(capture).toHaveBeenCalledWith(
      OnboardingAnalyticsEvent.PageViewed,
      expect.objectContaining({
        [OnboardingAnalyticsProperty.OwnAnalyzedSessionsVolume]:
          SessionVolumeBucket.TenToNinetyNine,
        [OnboardingAnalyticsProperty.OrgAnalyzedSessionsVolume]:
          UnknownSessionVolume,
      })
    );
  });

  it("emits unknown for unsettled reads at the deadline", () => {
    vi.useFakeTimers();
    inputs.own = { data: undefined, isSuccess: false, isError: false };
    inputs.org = { data: undefined, isSuccess: false, isError: false };
    const { capture } = setup();
    expect(capture).not.toHaveBeenCalled();
    act(() => vi.advanceTimersByTime(2000));
    expect(capture).toHaveBeenCalledWith(
      OnboardingAnalyticsEvent.PageViewed,
      expect.objectContaining({
        [OnboardingAnalyticsProperty.PageName]:
          OnboardingAnalyticsPageName.Dashboard,
        [OnboardingAnalyticsProperty.OwnAnalyzedSessionsVolume]:
          UnknownSessionVolume,
        [OnboardingAnalyticsProperty.OrgAnalyzedSessionsVolume]:
          UnknownSessionVolume,
      })
    );
  });

  it("starts the deadline after authentication resolves", () => {
    vi.useFakeTimers();
    inputs.auth = { status: DesktopAuthStatus.Loading, userId: null };
    inputs.own = { data: undefined, isSuccess: false, isError: false };
    inputs.org = { data: undefined, isSuccess: false, isError: false };
    const { capture, update } = setup();
    act(() => vi.advanceTimersByTime(2000));
    expect(capture).not.toHaveBeenCalled();

    inputs.auth = { status: DesktopAuthStatus.Authenticated, userId: "viewer" };
    update(true);
    expect(capture).not.toHaveBeenCalled();
    act(() => vi.advanceTimersByTime(1999));
    expect(capture).not.toHaveBeenCalled();
    act(() => vi.advanceTimersByTime(1));
    expect(capture).toHaveBeenCalledTimes(1);
  });

  it("emits both unknown when signed out", () => {
    inputs.auth = { status: DesktopAuthStatus.SignedOut, userId: null };
    const { capture } = setup();
    expect(capture).toHaveBeenCalledWith(
      OnboardingAnalyticsEvent.PageViewed,
      expect.objectContaining({
        [OnboardingAnalyticsProperty.PageName]:
          OnboardingAnalyticsPageName.Dashboard,
        [OnboardingAnalyticsProperty.OwnAnalyzedSessionsVolume]:
          UnknownSessionVolume,
        [OnboardingAnalyticsProperty.OrgAnalyzedSessionsVolume]:
          UnknownSessionVolume,
      })
    );
  });

  it("uses the shared zero bucket only for measured all-time zeroes", () => {
    inputs.own = { data: 0, isSuccess: true, isError: false };
    inputs.org = {
      data: {
        kpis: [{ key: "sessions", value: 0 }],
        charts: { userBreakdown: [] },
      },
      isSuccess: true,
      isError: false,
    };
    const { capture } = setup();
    expect(capture).toHaveBeenCalledWith(
      OnboardingAnalyticsEvent.PageViewed,
      expect.objectContaining({
        [OnboardingAnalyticsProperty.PageName]:
          OnboardingAnalyticsPageName.Dashboard,
        [OnboardingAnalyticsProperty.OwnAnalyzedSessionsVolume]:
          SessionVolumeBucket.Zero,
        [OnboardingAnalyticsProperty.OrgAnalyzedSessionsVolume]:
          SessionVolumeBucket.Zero,
      })
    );
  });
});
