import {
  SharedAnalyticsComponent,
  Surface,
  SurfaceAnalyticsEvent,
  type SurfaceAnalyticsProperties,
} from "@repo/api/src/types/surface-analytics";
import { render, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import {
  SurfaceAnalyticsProvider,
  useSharedComponentRenderedEvent,
  useSurfaceAnalytics,
} from "../surface-analytics-context";

function RenderedEventEmitter() {
  useSharedComponentRenderedEvent(SharedAnalyticsComponent.BranchDetailPage);
  return null;
}

function ManualEmitter({
  properties,
}: {
  properties: SurfaceAnalyticsProperties;
}) {
  const { capture } = useSurfaceAnalytics();
  capture(SurfaceAnalyticsEvent.DesktopMlpFeatureUsed, properties);
  return null;
}

describe("SurfaceAnalyticsProvider", () => {
  it("stamps the injected surface into every event's properties", () => {
    const capture = vi.fn();
    render(
      <SurfaceAnalyticsProvider capture={capture} surface={Surface.Desktop}>
        <ManualEmitter properties={{ feature: "trace" }} />
      </SurfaceAnalyticsProvider>
    );

    expect(capture).toHaveBeenCalledWith(
      SurfaceAnalyticsEvent.DesktopMlpFeatureUsed,
      { feature: "trace", surface: Surface.Desktop }
    );
  });

  it("wins over a caller-supplied surface property", () => {
    const capture = vi.fn();
    render(
      <SurfaceAnalyticsProvider capture={capture} surface={Surface.Web}>
        <ManualEmitter properties={{ surface: "forged" }} />
      </SurfaceAnalyticsProvider>
    );

    expect(capture).toHaveBeenCalledWith(
      SurfaceAnalyticsEvent.DesktopMlpFeatureUsed,
      { surface: Surface.Web }
    );
  });
});

describe("useSharedComponentRenderedEvent", () => {
  it("emits shared_component_rendered exactly once per mount", () => {
    const firstCapture = vi.fn();
    const secondCapture = vi.fn();
    const view = render(
      <SurfaceAnalyticsProvider capture={firstCapture} surface={Surface.Web}>
        <RenderedEventEmitter />
      </SurfaceAnalyticsProvider>
    );

    view.rerender(
      <SurfaceAnalyticsProvider capture={secondCapture} surface={Surface.Web}>
        <RenderedEventEmitter />
      </SurfaceAnalyticsProvider>
    );

    expect(firstCapture).toHaveBeenCalledTimes(1);
    expect(secondCapture).not.toHaveBeenCalled();
    expect(firstCapture).toHaveBeenCalledWith(
      SurfaceAnalyticsEvent.SharedComponentRendered,
      {
        component: SharedAnalyticsComponent.BranchDetailPage,
        surface: Surface.Web,
      }
    );
  });

  it("is a safe no-op without a mounted provider", () => {
    const { result } = renderHook(() => useSurfaceAnalytics());

    expect(result.current.surface).toBeNull();
    expect(() => render(<RenderedEventEmitter />)).not.toThrow();
  });
});
