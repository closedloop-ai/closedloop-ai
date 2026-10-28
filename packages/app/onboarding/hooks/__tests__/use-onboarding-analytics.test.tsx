import {
  OnboardingAnalyticsEvent,
  OnboardingAnalyticsProperty,
} from "@repo/api/src/types/onboarding-analytics";
import {
  OnboardingEvent,
  type OnboardingEventInput,
} from "@repo/api/src/types/onboarding-events";
import {
  restoreOnboardingState,
  serializeOnboardingState,
} from "@repo/api/src/types/onboarding-persistence";
import {
  AccountProvider,
  AccountStatus,
  createInitialOnboardingState,
  OnboardingHost,
  OnboardingPhase,
} from "@repo/api/src/types/onboarding-phase";
import {
  Surface,
  type SurfaceAnalyticsCapture,
} from "@repo/api/src/types/surface-analytics";
import { act, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SurfaceAnalyticsProvider } from "../../../shared/observability/surface-analytics-context";
import { buildOnboardingContext } from "../../lib/guided-onboarding-fixtures";
import {
  readOnboardingFlowSession,
  resetOnboardingFlowSessionForTests,
} from "../../lib/onboarding-flow-session";
import { transitionOnboarding } from "../../lib/onboarding-transitions";
import { useOnboardingFunnelAnalytics } from "../use-onboarding-analytics";

beforeEach(() => resetOnboardingFlowSessionForTests());

describe("onboarding funnel phase indices through the analytics provider", () => {
  it.each([OnboardingHost.Desktop, OnboardingHost.Web])(
    "captures the canonical %s sequence across persisted restorations",
    (host) => {
      const capture = vi.fn<SurfaceAnalyticsCapture>();
      const surface =
        host === OnboardingHost.Desktop ? Surface.Desktop : Surface.Web;
      const { result } = renderHook(() => useOnboardingFunnelAnalytics(host), {
        wrapper: ({ children }: { children: ReactNode }) => (
          <SurfaceAnalyticsProvider capture={capture} surface={surface}>
            {children}
          </SurfaceAnalyticsProvider>
        ),
      });
      let state = createInitialOnboardingState();
      let context = buildOnboardingContext({ host });
      act(() => result.current.captureFlowView(state));
      const flowId = readOnboardingFlowSession()?.flowId;
      const events: OnboardingEventInput[] = [{ type: OnboardingEvent.Start }];
      if (host === OnboardingHost.Desktop) {
        events.push({ type: OnboardingEvent.ContinueFromDiscovery });
      }
      events.push(
        {
          type: OnboardingEvent.AccountEstablished,
          provider: AccountProvider.Google,
        },
        { type: OnboardingEvent.OrganizationReady }
      );
      if (host === OnboardingHost.Desktop) {
        events.push({ type: OnboardingEvent.ContinueFromSyncPolicy });
      }
      events.push({ type: OnboardingEvent.SendInvitations });
      if (host === OnboardingHost.Web) {
        events.push({ type: OnboardingEvent.DownloadDesktopApp });
      }
      events.push(
        { type: OnboardingEvent.ConnectGitHub },
        { type: OnboardingEvent.DashboardEntered },
        { type: OnboardingEvent.FinishTour }
      );
      for (const event of events) {
        // Every step must retain its position across a persisted reload.
        state = restoreOnboardingState(
          serializeOnboardingState(state),
          host
        ).state;
        const transition = transitionOnboarding(state, event, context);
        expect(transition.status).toBe("moved");
        if (transition.status !== "moved") {
          throw new Error(transition.reason);
        }
        act(() =>
          result.current.captureTransition({
            context,
            event,
            priorState: state,
            nextState: transition.state,
          })
        );
        state = transition.state;
        if (event.type === OnboardingEvent.AccountEstablished) {
          context = {
            ...context,
            accountStatus: AccountStatus.Established,
            accountProvider: event.provider,
          };
        }
      }
      const phases =
        host === OnboardingHost.Desktop
          ? [
              OnboardingPhase.Welcome,
              OnboardingPhase.SessionDiscovery,
              OnboardingPhase.Account,
              OnboardingPhase.CreateOrganization,
              OnboardingPhase.SyncPolicy,
              OnboardingPhase.InviteTeam,
              OnboardingPhase.ConnectGitHub,
              OnboardingPhase.DashboardAvailable,
              OnboardingPhase.DashboardTour,
              OnboardingPhase.Ready,
            ]
          : [
              OnboardingPhase.Welcome,
              OnboardingPhase.Account,
              OnboardingPhase.CreateOrganization,
              OnboardingPhase.InviteTeam,
              OnboardingPhase.DownloadDesktop,
              OnboardingPhase.ConnectGitHub,
              OnboardingPhase.DashboardAvailable,
              OnboardingPhase.DashboardTour,
              OnboardingPhase.Ready,
            ];
      const viewed = capture.mock.calls.filter(
        ([event]) => event === OnboardingAnalyticsEvent.StepViewed
      );
      expect(
        viewed.map(([, properties]) => [
          properties[OnboardingAnalyticsProperty.Step],
          properties[OnboardingAnalyticsProperty.StepIndex],
        ])
      ).toEqual(phases.map((phase, index) => [phase, index]));
      const completed = capture.mock.calls.filter(
        ([event]) => event === OnboardingAnalyticsEvent.StepCompleted
      );
      expect(
        completed.map(
          ([, properties]) => properties[OnboardingAnalyticsProperty.StepIndex]
        )
      ).toEqual(phases.slice(0, -1).map((_, index) => index));
      for (const [, properties] of capture.mock.calls) {
        expect(properties).toMatchObject({
          [OnboardingAnalyticsProperty.FlowId]: flowId,
          surface,
        });
      }
    }
  );
});
