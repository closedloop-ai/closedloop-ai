/**
 * PRD-736 (ISS-10500) — the tour's analytics through the production engine:
 * started + step viewed on open, viewed on forward navigation only, `tour_back`
 * on Back, skipped/completed at close. All gated on the host-supplied
 * `tourSource`, so an unwired mount emits nothing.
 */

import {
  OnboardingAnalyticsEvent,
  OnboardingAnalyticsProperty,
  OnboardingCtaId,
  OnboardingTourSource,
} from "@repo/api/src/types/onboarding-analytics";
import {
  Surface,
  type SurfaceAnalyticsCapture,
} from "@repo/api/src/types/surface-analytics";
import { fireEvent, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DashboardTourAnchor } from "../../../../insights/components/overview/dashboard-tour-anchors";
import { SurfaceAnalyticsProvider } from "../../../../shared/observability/surface-analytics-context";
import {
  readOnboardingFlowSession,
  resetOnboardingFlowSessionForTests,
  startOnboardingFlowSession,
} from "../../../lib/onboarding-flow-session";
import { Tour } from "../dashboard-tour";
import type { TourStep } from "../dashboard-tour-types";

const NEXT_BUTTON = /Next/;
const BACK_BUTTON = /Back/;
const SKIP_BUTTON = /Skip tour/;
const DONE_BUTTON = /Done/;

const STEPS: TourStep[] = [
  {
    sel: DashboardTourAnchor.Stats,
    title: "Headline metrics",
    body: "First step body.",
  },
  {
    sel: DashboardTourAnchor.Prs,
    title: "Shipping velocity",
    body: "Last step body.",
  },
];

const capture = vi.fn<SurfaceAnalyticsCapture>();

function wrap(children: ReactNode) {
  return (
    <SurfaceAnalyticsProvider capture={capture} surface={Surface.Web}>
      {children}
    </SurfaceAnalyticsProvider>
  );
}

function eventsCaptured(): string[] {
  return capture.mock.calls.map(([event]) => event);
}

beforeEach(() => {
  vi.clearAllMocks();
  resetOnboardingFlowSessionForTests();
});

describe("dashboard tour analytics", () => {
  it("emits started and the first step view on open, and views forward navigation only", () => {
    render(
      wrap(
        <Tour
          active
          onClose={vi.fn()}
          resolveSteps={() => STEPS}
          tourSource={OnboardingTourSource.WebTeammateData}
        />
      )
    );

    expect(eventsCaptured()).toEqual([
      OnboardingAnalyticsEvent.TourStarted,
      OnboardingAnalyticsEvent.TourStepViewed,
    ]);
    expect(capture.mock.calls[1]?.[1]).toMatchObject({
      [OnboardingAnalyticsProperty.TourSource]:
        OnboardingTourSource.WebTeammateData,
      [OnboardingAnalyticsProperty.TourStepId]: DashboardTourAnchor.Stats,
      [OnboardingAnalyticsProperty.TourStepIndex]: 0,
    });

    fireEvent.click(screen.getByRole("button", { name: NEXT_BUTTON }));
    expect(eventsCaptured().at(-1)).toBe(
      OnboardingAnalyticsEvent.TourStepViewed
    );
    expect(capture.mock.calls.at(-1)?.[1]).toMatchObject({
      [OnboardingAnalyticsProperty.TourStepIndex]: 1,
    });

    // Backward navigation is the tour_back CTA, never a step view.
    fireEvent.click(screen.getByRole("button", { name: BACK_BUTTON }));
    expect(eventsCaptured().at(-1)).toBe(OnboardingAnalyticsEvent.CtaClicked);
    expect(capture.mock.calls.at(-1)?.[1]).toMatchObject({
      [OnboardingAnalyticsProperty.CtaId]: OnboardingCtaId.TourBack,
    });
    expect(
      eventsCaptured().filter(
        (event) => event === OnboardingAnalyticsEvent.TourStepViewed
      )
    ).toHaveLength(2);
  });

  // The tour also runs AFTER the flow ended (Ready arm via the getting-started
  // card). Its context read must be READ-ONLY: minting would persist a session
  // whose flow_id names no attempt and whose presence suppresses the next
  // genuine flow_started in the tab.
  it("omits flow context and mints no session when no flow is live", () => {
    render(
      wrap(
        <Tour
          active
          onClose={vi.fn()}
          resolveSteps={() => STEPS}
          tourSource={OnboardingTourSource.WebTeammateData}
        />
      )
    );

    expect(eventsCaptured()).toContain(OnboardingAnalyticsEvent.TourStarted);
    for (const [, properties] of capture.mock.calls) {
      expect(properties).not.toHaveProperty(OnboardingAnalyticsProperty.FlowId);
    }
    expect(readOnboardingFlowSession()).toBeNull();
  });

  it("carries the live flow's id when the tour runs inside the flow", () => {
    const session = startOnboardingFlowSession(Date.now());
    render(
      wrap(
        <Tour
          active
          onClose={vi.fn()}
          resolveSteps={() => STEPS}
          tourSource={OnboardingTourSource.WebTeammateData}
        />
      )
    );

    expect(capture.mock.calls[0]?.[1]).toMatchObject({
      [OnboardingAnalyticsProperty.FlowId]: session.flowId,
    });
  });

  it("emits tour_skipped with the abandoned step at skip", () => {
    const onClose = vi.fn();
    render(
      wrap(
        <Tour
          active
          onClose={onClose}
          resolveSteps={() => STEPS}
          tourSource={OnboardingTourSource.Onboarding}
        />
      )
    );
    // Two controls carry this name: the full-viewport click blocker and the
    // callout's text button. Either one skips; use the blocker.
    fireEvent.click(screen.getAllByRole("button", { name: SKIP_BUTTON })[0]);

    expect(eventsCaptured().at(-1)).toBe(OnboardingAnalyticsEvent.TourSkipped);
    expect(capture.mock.calls.at(-1)?.[1]).toMatchObject({
      [OnboardingAnalyticsProperty.AtTourStepIndex]: 0,
      [OnboardingAnalyticsProperty.AtTourStepId]: DashboardTourAnchor.Stats,
      [OnboardingAnalyticsProperty.TourSource]: OnboardingTourSource.Onboarding,
    });
    expect(onClose).toHaveBeenCalled();
  });

  it("emits tour_completed with the distinct steps viewed at Done", () => {
    render(
      wrap(
        <Tour
          active
          onClose={vi.fn()}
          resolveSteps={() => STEPS}
          tourSource={OnboardingTourSource.WebTeammateData}
        />
      )
    );
    fireEvent.click(screen.getByRole("button", { name: NEXT_BUTTON }));
    fireEvent.click(screen.getByRole("button", { name: DONE_BUTTON }));

    expect(eventsCaptured().at(-1)).toBe(
      OnboardingAnalyticsEvent.TourCompleted
    );
    expect(capture.mock.calls.at(-1)?.[1]).toMatchObject({
      [OnboardingAnalyticsProperty.TourStepsViewedCount]: 2,
    });
  });

  it("freezes tour_source with the run: a mid-run source flip cannot relabel later events", () => {
    const view = render(
      wrap(
        <Tour
          active
          onClose={vi.fn()}
          resolveSteps={() => STEPS}
          tourSource={OnboardingTourSource.WebTeammateData}
        />
      )
    );
    view.rerender(
      wrap(
        <Tour
          active
          onClose={vi.fn()}
          resolveSteps={() => STEPS}
          tourSource={OnboardingTourSource.Onboarding}
        />
      )
    );
    fireEvent.click(screen.getByRole("button", { name: NEXT_BUTTON }));

    expect(capture.mock.calls.at(-1)?.[0]).toBe(
      OnboardingAnalyticsEvent.TourStepViewed
    );
    expect(capture.mock.calls.at(-1)?.[1]).toMatchObject({
      [OnboardingAnalyticsProperty.TourSource]:
        OnboardingTourSource.WebTeammateData,
    });
  });

  it("emits nothing when the host supplies no tour source", () => {
    render(wrap(<Tour active onClose={vi.fn()} resolveSteps={() => STEPS} />));
    fireEvent.click(screen.getByRole("button", { name: NEXT_BUTTON }));

    expect(capture).not.toHaveBeenCalled();
  });
});
