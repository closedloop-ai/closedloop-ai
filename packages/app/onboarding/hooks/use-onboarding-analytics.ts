"use client";

import {
  FirstOrgUserValue,
  OnboardingAnalyticsEvent,
  OnboardingAnalyticsProperty,
  type OnboardingCtaId,
} from "@repo/api/src/types/onboarding-analytics";
import {
  OnboardingEvent,
  type OnboardingEventInput,
} from "@repo/api/src/types/onboarding-events";
import {
  type OnboardingContext,
  type OnboardingHost,
  type OnboardingMachineState,
  OnboardingPhase,
  OrganizationMembership,
} from "@repo/api/src/types/onboarding-phase";
import { useCallback, useRef } from "react";
import { useSurfaceAnalytics } from "../../shared/observability/surface-analytics-context";
import {
  endOnboardingFlowSession,
  ensureOnboardingFlowSession,
  readOnboardingFlowSession,
  recordOnboardingFirstOrgUser,
  recordOnboardingStepSkipped,
  startOnboardingFlowSession,
} from "../lib/onboarding-flow-session";
import {
  deriveOnboardingTransitionEmissions,
  firstOrgUserValue,
  isOnboardingSkipEvent,
  type OnboardingTransitionAnalyticsOutcome,
  onboardingContextProperties,
  onboardingEntryPointForHost,
} from "../lib/onboarding-funnel-analytics";

/**
 * The FSM-side capture half of PRD-736 W2 (ISS-10500). One emit site: the
 * transition consumer calls {@link captureTransition} for every ACCEPTED
 * transition, and the dialog host calls {@link captureFlowView} when it shows
 * a restored run — the only view no transition produces (a fresh Welcome).
 * Emission rides the surface-analytics port, so a mount without a provider
 * (tests, Storybook) captures nothing and never breaks a render.
 */
export function useOnboardingFunnelAnalytics(host: OnboardingHost): {
  captureTransition: (input: {
    context: OnboardingContext;
    event: OnboardingEventInput;
    nextState: OnboardingMachineState;
    outcome?: OnboardingTransitionAnalyticsOutcome;
    priorState: OnboardingMachineState;
  }) => void;
  captureFlowView: (state: OnboardingMachineState) => void;
} {
  const { capture, setPersonProperties } = useSurfaceAnalytics();
  const flowViewCapturedRef = useRef(false);

  const captureTransition = useCallback(
    (input: {
      context: OnboardingContext;
      event: OnboardingEventInput;
      nextState: OnboardingMachineState;
      outcome?: OnboardingTransitionAnalyticsOutcome;
      priorState: OnboardingMachineState;
    }) => {
      ensureOnboardingFlowSession();
      if (isOnboardingSkipEvent(input.event)) {
        recordOnboardingStepSkipped(input.priorState.phase);
      }
      if (input.event.type === OnboardingEvent.OrganizationReady) {
        // Membership, not the phase left: a first user already in the
        // organization Clerk's signup made leaves ChooseOrganization (ISS-11090).
        const firstOrgUser =
          input.context.membership === OrganizationMembership.FirstUser
            ? FirstOrgUserValue.True
            : FirstOrgUserValue.False;
        recordOnboardingFirstOrgUser(firstOrgUser);
        // PRD-736: also a PERSON property at the moment it resolves, because
        // flow events expire from useful query windows and long-horizon
        // segmentation needs it on the person.
        setPersonProperties({
          [OnboardingAnalyticsProperty.FirstOrgUser]: firstOrgUser,
        });
      }
      const session = ensureOnboardingFlowSession();
      for (const emission of deriveOnboardingTransitionEmissions({
        ...input,
        host,
        session,
      })) {
        capture(emission.event, emission.properties);
      }
      if (input.nextState.phase === OnboardingPhase.Ready) {
        endOnboardingFlowSession();
      }
    },
    [capture, host, setPersonProperties]
  );

  const captureFlowView = useCallback(
    (state: OnboardingMachineState) => {
      // Only a FRESH run's first Welcome render starts a flow; a restored
      // mid-flow run already emitted its `step_viewed` from the transition
      // that entered its phase, and re-emitting per mount would count reloads
      // as views. Once per mount, and once per flow via the session store.
      // Keyed on `startedAtMs`, not mere presence: a lazily minted session
      // (startedAtMs null) at a fresh Welcome is a stale leftover — a live
      // flow this client observed always recorded its start — and blocking on
      // it would silence the genuine flow_started forever in that tab.
      if (
        flowViewCapturedRef.current ||
        state.phase !== OnboardingPhase.Welcome ||
        state.history.length > 0 ||
        readOnboardingFlowSession()?.startedAtMs != null
      ) {
        return;
      }
      flowViewCapturedRef.current = true;
      const session = startOnboardingFlowSession(Date.now());
      capture(OnboardingAnalyticsEvent.FlowStarted, {
        ...onboardingContextProperties({
          host,
          phase: OnboardingPhase.Welcome,
          session,
        }),
        [OnboardingAnalyticsProperty.EntryPoint]:
          onboardingEntryPointForHost(host),
      });
      capture(OnboardingAnalyticsEvent.StepViewed, {
        ...onboardingContextProperties({
          host,
          phase: OnboardingPhase.Welcome,
          session,
        }),
        [OnboardingAnalyticsProperty.Step]: OnboardingPhase.Welcome,
      });
    },
    [capture, host]
  );

  return { captureFlowView, captureTransition };
}

/**
 * `onboarding_cta_clicked` for the funnel controls the FSM has no transition
 * for (PRD-736 decision #14). Components call this directly — the one
 * deliberate exception to "instrument the state machine, not the components",
 * because these controls are by definition invisible to the machine.
 */
export function useOnboardingCtaAnalytics(): {
  captureCtaClick: (input: {
    ctaId: OnboardingCtaId;
    step: OnboardingPhase;
  }) => void;
} {
  const { capture } = useSurfaceAnalytics();
  const captureCtaClick = useCallback(
    (input: { ctaId: OnboardingCtaId; step: OnboardingPhase }) => {
      // Read-only: CTAs also fire AFTER the flow ended (the getting-started
      // card, tour back). Minting here would persist a session for a flow that
      // is not happening and suppress the next genuine flow_started; with no
      // live flow the click is still real, so flow context is omitted, never
      // invented.
      const session = readOnboardingFlowSession();
      capture(OnboardingAnalyticsEvent.CtaClicked, {
        ...(session === null
          ? {}
          : {
              [OnboardingAnalyticsProperty.FlowId]: session.flowId,
              [OnboardingAnalyticsProperty.FirstOrgUser]:
                firstOrgUserValue(session),
            }),
        [OnboardingAnalyticsProperty.Step]: input.step,
        [OnboardingAnalyticsProperty.CtaId]: input.ctaId,
      });
    },
    [capture]
  );
  return { captureCtaClick };
}
