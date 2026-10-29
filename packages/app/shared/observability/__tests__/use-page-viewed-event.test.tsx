import {
  OnboardingAnalyticsEvent,
  OnboardingAnalyticsPageName,
  OnboardingAnalyticsProperty,
  SessionVolumeBucket,
} from "@repo/api/src/types/onboarding-analytics";
import {
  Surface,
  type SurfaceAnalyticsCapture,
} from "@repo/api/src/types/surface-analytics";
import { render } from "@testing-library/react";
import { StrictMode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SurfaceAnalyticsProvider } from "../surface-analytics-context";
import { usePageViewedEvent } from "../use-page-viewed-event";

const capture = vi.fn<SurfaceAnalyticsCapture>();

function PageProbe({
  properties,
  ready,
}: {
  properties?: Record<string, string>;
  ready?: boolean;
}) {
  usePageViewedEvent(OnboardingAnalyticsPageName.Dashboard, {
    properties,
    ready,
  });
  return null;
}

function mount(node: React.ReactNode) {
  return render(
    <StrictMode>
      <SurfaceAnalyticsProvider capture={capture} surface={Surface.Web}>
        {node}
      </SurfaceAnalyticsProvider>
    </StrictMode>
  );
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("usePageViewedEvent", () => {
  it("emits exactly one page_viewed per mount under StrictMode", () => {
    const view = mount(<PageProbe />);
    view.rerender(
      <StrictMode>
        <SurfaceAnalyticsProvider capture={capture} surface={Surface.Web}>
          <PageProbe />
        </SurfaceAnalyticsProvider>
      </StrictMode>
    );

    expect(capture).toHaveBeenCalledTimes(1);
    expect(capture).toHaveBeenCalledWith(OnboardingAnalyticsEvent.PageViewed, {
      [OnboardingAnalyticsProperty.PageName]:
        OnboardingAnalyticsPageName.Dashboard,
      surface: Surface.Web,
    });
  });

  it("defers the single emit until ready, then carries the settled properties", () => {
    const view = mount(<PageProbe ready={false} />);
    expect(capture).not.toHaveBeenCalled();

    view.rerender(
      <StrictMode>
        <SurfaceAnalyticsProvider capture={capture} surface={Surface.Web}>
          <PageProbe
            properties={{
              [OnboardingAnalyticsProperty.OwnAnalyzedSessionsVolume]:
                SessionVolumeBucket.OneToNine,
            }}
            ready
          />
        </SurfaceAnalyticsProvider>
      </StrictMode>
    );

    expect(capture).toHaveBeenCalledTimes(1);
    expect(capture.mock.calls[0]?.[1]).toMatchObject({
      [OnboardingAnalyticsProperty.OwnAnalyzedSessionsVolume]:
        SessionVolumeBucket.OneToNine,
      [OnboardingAnalyticsProperty.PageName]:
        OnboardingAnalyticsPageName.Dashboard,
    });
  });
});
