"use client";

import {
  OnboardingAnalyticsEvent,
  OnboardingAnalyticsProperty,
  OnboardingCtaId,
  type OnboardingTourSource,
} from "@repo/api/src/types/onboarding-analytics";
import { OnboardingPhase } from "@repo/api/src/types/onboarding-phase";
import type { SurfaceAnalyticsProperties } from "@repo/api/src/types/surface-analytics";
import { useCallback, useEffect, useRef } from "react";
import { useSurfaceAnalytics } from "../../../shared/observability/surface-analytics-context";
import { useOnboardingCtaAnalytics } from "../../hooks/use-onboarding-analytics";
import { readOnboardingFlowSession } from "../../lib/onboarding-flow-session";
import { firstOrgUserValue } from "../../lib/onboarding-funnel-analytics";
import { TourCloseReason, type TourStep } from "./dashboard-tour-types";

/**
 * PRD-736 dashboard-tour events (ISS-10500), emitted by the shared `Tour`
 * engine so web and desktop cannot drift on when a step counts as viewed.
 * Inert until the host supplies `tourSource` — the one fact only the host
 * knows — so an unwired mount emits nothing rather than a malformed event.
 *
 * Forward navigation is `onboarding_tour_step_viewed`; backward navigation is
 * the `tour_back` CTA (PRD-736 §Dashboard tour events), so re-entering a step
 * from Back emits nothing.
 */
export function useDashboardTourAnalytics({
  active,
  step,
  stepIndex,
  tourSource,
}: {
  active: boolean;
  step: TourStep | undefined;
  stepIndex: number;
  tourSource: OnboardingTourSource | undefined;
}): {
  captureTourEnd: (reason: TourCloseReason) => void;
  captureTourBack: () => void;
} {
  const { capture } = useSurfaceAnalytics();
  const { captureCtaClick } = useOnboardingCtaAnalytics();
  const runRef = useRef<TourAnalyticsRun | null>(null);
  const latestRef = useRef({ step, stepIndex, tourSource });
  latestRef.current = { step, stepIndex, tourSource };

  useEffect(() => {
    if (!(tourSource && active)) {
      runRef.current = null;
      return;
    }
    if (!step) {
      return;
    }
    if (runRef.current === null) {
      // The source is FROZEN with the run, like the engine's own runSteps: the
      // host derives it from live dashboard state, and a mid-run content-state
      // flip must not relabel a tour that already started under one source.
      runRef.current = {
        prevIndex: null,
        tourSource,
        viewedIndexes: new Set(),
      };
      capture(OnboardingAnalyticsEvent.TourStarted, {
        ...tourContextProperties(),
        [OnboardingAnalyticsProperty.TourSource]: tourSource,
      });
    }
    const run = runRef.current;
    if (run.prevIndex === null || stepIndex > run.prevIndex) {
      run.viewedIndexes.add(stepIndex);
      capture(OnboardingAnalyticsEvent.TourStepViewed, {
        ...tourContextProperties(),
        [OnboardingAnalyticsProperty.TourSource]: run.tourSource,
        [OnboardingAnalyticsProperty.TourStepId]: step.sel,
        [OnboardingAnalyticsProperty.TourStepIndex]: stepIndex,
      });
    }
    run.prevIndex = stepIndex;
  }, [active, capture, step, stepIndex, tourSource]);

  const captureTourEnd = useCallback(
    (reason: TourCloseReason) => {
      const latest = latestRef.current;
      const run = runRef.current;
      // An `Empty` close never showed anything, so there is no run to report.
      if (!(latest.tourSource && run) || reason === TourCloseReason.Empty) {
        return;
      }
      if (reason === TourCloseReason.Done) {
        capture(OnboardingAnalyticsEvent.TourCompleted, {
          ...tourContextProperties(),
          [OnboardingAnalyticsProperty.TourSource]: run.tourSource,
          [OnboardingAnalyticsProperty.TourStepsViewedCount]:
            run.viewedIndexes.size,
        });
        return;
      }
      capture(OnboardingAnalyticsEvent.TourSkipped, {
        ...tourContextProperties(),
        [OnboardingAnalyticsProperty.TourSource]: run.tourSource,
        [OnboardingAnalyticsProperty.AtTourStepIndex]: latest.stepIndex,
        ...(latest.step
          ? { [OnboardingAnalyticsProperty.AtTourStepId]: latest.step.sel }
          : {}),
      });
    },
    [capture]
  );

  const captureTourBack = useCallback(() => {
    if (!latestRef.current.tourSource) {
      return;
    }
    captureCtaClick({
      ctaId: OnboardingCtaId.TourBack,
      step: OnboardingPhase.DashboardTour,
    });
  }, [captureCtaClick]);

  return { captureTourBack, captureTourEnd };
}

type TourAnalyticsRun = {
  prevIndex: number | null;
  /** The source the run STARTED under; every event of the run reports it. */
  tourSource: OnboardingTourSource;
  viewedIndexes: Set<number>;
};

/**
 * Read-only flow context: the tour also runs AFTER the flow ended (the Ready
 * arm via the getting-started card, where captureTransition already ended the
 * session). Minting here would persist a session for a flow that is not
 * happening — its flow_id would name no onboarding attempt, and its presence
 * would suppress the next genuine flow_started in the tab. With no live flow
 * the tour events carry no flow context rather than an invented one.
 */
function tourContextProperties(): SurfaceAnalyticsProperties {
  const session = readOnboardingFlowSession();
  if (session === null) {
    return {};
  }
  return {
    [OnboardingAnalyticsProperty.FlowId]: session.flowId,
    [OnboardingAnalyticsProperty.FirstOrgUser]: firstOrgUserValue(session),
  };
}
