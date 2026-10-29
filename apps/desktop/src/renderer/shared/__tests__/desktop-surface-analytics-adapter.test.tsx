/**
 * ISS-8752 — the desktop half of the surface-attributed analytics port.
 *
 * Proves an event emitted through `useSurfaceAnalytics()` under the desktop
 * adapter reaches `window.desktopApi.captureSurfaceAnalytics` carrying
 * `surface: "desktop"`, and that an old preload without the bridge method
 * drops the event without breaking the render (version skew).
 */

import { FeatureAssignmentDelivery } from "@repo/api/src/types/feature-assignment-delivery";
import {
  OnboardingAnalyticsEvent,
  OnboardingAnalyticsProperty,
} from "@repo/api/src/types/onboarding-analytics";
import {
  GridviewRolloutDecisionOutcome,
  SharedAnalyticsComponent,
  Surface,
  SurfaceAnalyticsEvent,
} from "@repo/api/src/types/surface-analytics";
import { useSurfaceAnalytics } from "@repo/app/shared/observability/surface-analytics-context";
import { render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DesktopSurfaceAnalyticsProvider } from "../desktop-surface-analytics-adapter";

function PortEmitter() {
  const { capture } = useSurfaceAnalytics();
  capture(SurfaceAnalyticsEvent.SharedComponentRendered, {
    component: SharedAnalyticsComponent.BranchDetailPage,
    skipped: undefined,
  });
  return null;
}

function RolloutDecisionEmitter() {
  const { capture } = useSurfaceAnalytics();
  capture(SurfaceAnalyticsEvent.GridviewRolloutDecision, {
    component: SharedAnalyticsComponent.BranchesListSurfaceV2,
    outcome: GridviewRolloutDecisionOutcome.Enabled,
    reason: FeatureAssignmentDelivery.Assigned,
    skipped: undefined,
  });
  return null;
}

const originalDesktopApi = window.desktopApi;

afterEach(() => {
  Object.defineProperty(window, "desktopApi", {
    configurable: true,
    value: originalDesktopApi,
    writable: true,
  });
});

function stubDesktopApi(api: unknown) {
  Object.defineProperty(window, "desktopApi", {
    configurable: true,
    value: api,
    writable: true,
  });
}

describe("DesktopSurfaceAnalyticsProvider", () => {
  it("relays port events over IPC with surface=desktop, dropping undefined properties", () => {
    const captureSurfaceAnalytics = vi.fn().mockResolvedValue({ ok: true });
    stubDesktopApi({ captureSurfaceAnalytics });

    render(
      <DesktopSurfaceAnalyticsProvider>
        <PortEmitter />
      </DesktopSurfaceAnalyticsProvider>
    );

    expect(captureSurfaceAnalytics).toHaveBeenCalledWith({
      event: SurfaceAnalyticsEvent.SharedComponentRendered,
      properties: {
        component: SharedAnalyticsComponent.BranchDetailPage,
        surface: Surface.Desktop,
      },
    });
  });

  it("drops events best-effort when the preload lacks the bridge method", () => {
    stubDesktopApi({});

    expect(() =>
      render(
        <DesktopSurfaceAnalyticsProvider>
          <PortEmitter />
        </DesktopSurfaceAnalyticsProvider>
      )
    ).not.toThrow();
  });

  it("relays grid-table rollout decisions over IPC", () => {
    const captureSurfaceAnalytics = vi.fn().mockResolvedValue({ ok: true });
    stubDesktopApi({ captureSurfaceAnalytics });

    render(
      <DesktopSurfaceAnalyticsProvider>
        <RolloutDecisionEmitter />
      </DesktopSurfaceAnalyticsProvider>
    );

    expect(captureSurfaceAnalytics).toHaveBeenCalledWith({
      event: SurfaceAnalyticsEvent.GridviewRolloutDecision,
      properties: {
        component: SharedAnalyticsComponent.BranchesListSurfaceV2,
        outcome: GridviewRolloutDecisionOutcome.Enabled,
        reason: FeatureAssignmentDelivery.Assigned,
        surface: Surface.Desktop,
      },
    });
  });

  it("relays onboarding funnel events without a component requirement (ISS-10502)", () => {
    const captureSurfaceAnalytics = vi.fn().mockResolvedValue({ ok: true });
    stubDesktopApi({ captureSurfaceAnalytics });

    function OnboardingEmitter() {
      const { capture } = useSurfaceAnalytics();
      capture(OnboardingAnalyticsEvent.FlowCompleted, {
        [OnboardingAnalyticsProperty.FlowId]: "flow-1",
        [OnboardingAnalyticsProperty.StepsSkipped]: ["account"],
        skipped: undefined,
      });
      return null;
    }

    render(
      <DesktopSurfaceAnalyticsProvider>
        <OnboardingEmitter />
      </DesktopSurfaceAnalyticsProvider>
    );

    expect(captureSurfaceAnalytics).toHaveBeenCalledWith({
      event: OnboardingAnalyticsEvent.FlowCompleted,
      properties: {
        [OnboardingAnalyticsProperty.FlowId]: "flow-1",
        [OnboardingAnalyticsProperty.StepsSkipped]: ["account"],
        surface: Surface.Desktop,
      },
    });
  });

  it("still requires a shared component on the MLP surface events", () => {
    const captureSurfaceAnalytics = vi.fn().mockResolvedValue({ ok: true });
    stubDesktopApi({ captureSurfaceAnalytics });

    function ComponentlessSurfaceEmitter() {
      const { capture } = useSurfaceAnalytics();
      capture(SurfaceAnalyticsEvent.SharedComponentRendered, {});
      return null;
    }

    render(
      <DesktopSurfaceAnalyticsProvider>
        <ComponentlessSurfaceEmitter />
      </DesktopSurfaceAnalyticsProvider>
    );

    expect(captureSurfaceAnalytics).not.toHaveBeenCalled();
  });

  it("does not relay reserved events outside the desktop IPC contract", () => {
    const captureSurfaceAnalytics = vi.fn().mockResolvedValue({ ok: true });
    stubDesktopApi({ captureSurfaceAnalytics });

    function ReservedEventEmitter() {
      const { capture } = useSurfaceAnalytics();
      capture(SurfaceAnalyticsEvent.DesktopMlpFeatureUsed, {});
      return null;
    }

    render(
      <DesktopSurfaceAnalyticsProvider>
        <ReservedEventEmitter />
      </DesktopSurfaceAnalyticsProvider>
    );

    expect(captureSurfaceAnalytics).not.toHaveBeenCalled();
  });
});
