/**
 * PRD-736 (ISS-10500) — the production wiring: an ACCEPTED transition through
 * `useGuidedOnboardingTransition` reaches the surface-analytics port with the
 * funnel events, not just the derivation helper in isolation. A rejected
 * transition emits nothing.
 */

import {
  OnboardingAnalyticsEvent,
  OnboardingAnalyticsProperty,
} from "@repo/api/src/types/onboarding-analytics";
import { OnboardingEvent } from "@repo/api/src/types/onboarding-events";
import {
  OnboardingHost,
  OnboardingPhase,
} from "@repo/api/src/types/onboarding-phase";
import {
  Surface,
  type SurfaceAnalyticsCapture,
} from "@repo/api/src/types/surface-analytics";
import { WorkspaceExperience } from "@repo/api/src/types/workspace-experience";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SurfaceAnalyticsProvider } from "../../../shared/observability/surface-analytics-context";
import { resetOnboardingFlowSessionForTests } from "../../lib/onboarding-flow-session";
import { useGuidedOnboardingTransition } from "../use-guided-onboarding";
import {
  createGuidedQueryClient,
  createGuidedWrapper,
  tourSnapshot,
} from "./guided-onboarding.test-helpers";

const mockApiClient = { get: vi.fn(), post: vi.fn() };

vi.mock("../../../shared/api/use-api-client", () => ({
  useApiClient: () => mockApiClient,
}));

const capture = vi.fn<SurfaceAnalyticsCapture>();
const setPersonProperties = vi.fn();

function createAnalyticsWrapper() {
  const queryClient = createGuidedQueryClient();
  const inner = createGuidedWrapper(queryClient);
  return ({ children }: { children: ReactNode }) =>
    inner({
      children: (
        <SurfaceAnalyticsProvider
          capture={capture}
          setPersonProperties={setPersonProperties}
          surface={Surface.Web}
        >
          {children}
        </SurfaceAnalyticsProvider>
      ),
    });
}

beforeEach(() => {
  vi.clearAllMocks();
  resetOnboardingFlowSessionForTests();
});

describe("guided onboarding transition analytics wiring", () => {
  it("captures the funnel events for an accepted transition, surface-stamped", async () => {
    mockApiClient.post.mockResolvedValue(null);
    const { result } = renderHook(
      () =>
        useGuidedOnboardingTransition({
          analysisStarted: false,
          experienceVariant: WorkspaceExperience.V2,
          host: OnboardingHost.Web,
        }),
      { wrapper: createAnalyticsWrapper() }
    );

    act(() => {
      result.current.mutate({
        event: { type: OnboardingEvent.FinishTour },
        snapshot: tourSnapshot(),
      });
    });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    const events = capture.mock.calls.map(([event]) => event);
    expect(events).toEqual([
      OnboardingAnalyticsEvent.StepCompleted,
      OnboardingAnalyticsEvent.StepViewed,
      OnboardingAnalyticsEvent.FlowCompleted,
    ]);
    const [, completedProps] =
      capture.mock.calls.find(
        ([event]) => event === OnboardingAnalyticsEvent.StepCompleted
      ) ?? [];
    expect(completedProps).toMatchObject({
      [OnboardingAnalyticsProperty.Step]: OnboardingPhase.DashboardTour,
      // The provider stamps the surface after caller properties.
      surface: Surface.Web,
    });
    expect(completedProps?.[OnboardingAnalyticsProperty.FlowId]).toEqual(
      expect.any(String)
    );
  });

  it("resolves first_org_user as a person property at org-step resolution", async () => {
    mockApiClient.post.mockResolvedValue(null);
    const orgSnapshot = tourSnapshot();
    const snapshot = {
      ...orgSnapshot,
      state: {
        ...orgSnapshot.state,
        history: [OnboardingPhase.Welcome, OnboardingPhase.Account],
        phase: OnboardingPhase.CreateOrganization,
      },
    };
    const { result } = renderHook(
      () =>
        useGuidedOnboardingTransition({
          analysisStarted: false,
          experienceVariant: WorkspaceExperience.V2,
          host: OnboardingHost.Web,
        }),
      { wrapper: createAnalyticsWrapper() }
    );

    act(() => {
      result.current.mutate({
        event: { type: OnboardingEvent.OrganizationReady },
        snapshot,
      });
    });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(setPersonProperties).toHaveBeenCalledWith({
      [OnboardingAnalyticsProperty.FirstOrgUser]: "true",
    });
    const [, completedProps] =
      capture.mock.calls.find(
        ([event]) => event === OnboardingAnalyticsEvent.StepCompleted
      ) ?? [];
    expect(completedProps).toMatchObject({
      [OnboardingAnalyticsProperty.FirstOrgUser]: "true",
    });
  });

  it("resolves first_org_user true for a first user choosing the organization their signup made (ISS-11090)", async () => {
    mockApiClient.post.mockResolvedValue(null);
    const orgSnapshot = tourSnapshot();
    const snapshot = {
      ...orgSnapshot,
      state: {
        ...orgSnapshot.state,
        history: [OnboardingPhase.Welcome],
        phase: OnboardingPhase.ChooseOrganization,
      },
    };
    const { result } = renderHook(
      () =>
        useGuidedOnboardingTransition({
          analysisStarted: false,
          experienceVariant: WorkspaceExperience.V2,
          host: OnboardingHost.Web,
        }),
      { wrapper: createAnalyticsWrapper() }
    );

    act(() => {
      result.current.mutate({
        event: { type: OnboardingEvent.OrganizationReady },
        snapshot,
      });
    });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(setPersonProperties).toHaveBeenCalledWith({
      [OnboardingAnalyticsProperty.FirstOrgUser]: "true",
    });
  });

  // ISS-11090 review: the host shows a run parked on CreateOrganization the
  // choose step, whose CTAs are tagged choose_organization, so the transition
  // off it must report and persist that step too, not the one never rendered.
  it("reports a run parked on create as the choose step it shows", async () => {
    mockApiClient.post.mockResolvedValue(null);
    const orgSnapshot = tourSnapshot();
    const snapshot = {
      ...orgSnapshot,
      state: {
        ...orgSnapshot.state,
        history: [OnboardingPhase.Welcome, OnboardingPhase.Account],
        phase: OnboardingPhase.CreateOrganization,
      },
    };
    const { result } = renderHook(
      () =>
        useGuidedOnboardingTransition({
          analysisStarted: false,
          experienceVariant: WorkspaceExperience.V2,
          host: OnboardingHost.Web,
        }),
      { wrapper: createAnalyticsWrapper() }
    );

    act(() => {
      result.current.mutate({
        event: { type: OnboardingEvent.OrganizationReady },
        snapshot,
      });
    });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    const [, completedProps] =
      capture.mock.calls.find(
        ([event]) => event === OnboardingAnalyticsEvent.StepCompleted
      ) ?? [];
    expect(completedProps?.[OnboardingAnalyticsProperty.Step]).toBe(
      OnboardingPhase.ChooseOrganization
    );
    const [, command] = mockApiClient.post.mock.calls[0] ?? [];
    expect(command.state.history.at(-1)).toBe(
      OnboardingPhase.ChooseOrganization
    );
  });

  it("captures nothing for a transition the machine rejects", async () => {
    const { result } = renderHook(
      () =>
        useGuidedOnboardingTransition({
          analysisStarted: false,
          experienceVariant: WorkspaceExperience.V2,
          host: OnboardingHost.Web,
        }),
      { wrapper: createAnalyticsWrapper() }
    );

    act(() => {
      result.current.mutate({
        // The tour phase has no `start` edge, so the machine refuses this.
        event: { type: OnboardingEvent.Start },
        snapshot: tourSnapshot(),
      });
    });
    await waitFor(() => expect(result.current.isError).toBe(true));

    expect(capture).not.toHaveBeenCalled();
    expect(mockApiClient.post).not.toHaveBeenCalled();
  });

  // ISS-12423: a command carrying a transition the caller's local run already
  // captured still reaches the server, and is not captured a second time.
  it("posts an already-captured transition without capturing it again", async () => {
    mockApiClient.post.mockResolvedValue(null);
    const { result } = renderHook(
      () =>
        useGuidedOnboardingTransition({
          analysisStarted: false,
          experienceVariant: WorkspaceExperience.V2,
          host: OnboardingHost.Web,
        }),
      { wrapper: createAnalyticsWrapper() }
    );

    act(() => {
      result.current.mutate({
        alreadyCaptured: true,
        event: { type: OnboardingEvent.FinishTour },
        snapshot: tourSnapshot(),
      });
    });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(mockApiClient.post).toHaveBeenCalledOnce();
    expect(capture).not.toHaveBeenCalled();
    expect(setPersonProperties).not.toHaveBeenCalled();
  });
});
