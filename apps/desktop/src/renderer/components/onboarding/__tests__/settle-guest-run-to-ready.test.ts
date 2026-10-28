/**
 * ISS-11480 (PLN-2126 Step 3): a desktop guest's run parks on the Dashboard
 * phases, and `resume_pending_step` is accepted only from Ready. The helper
 * folds the run there through the machine's own edges, and only the ones that
 * record nothing about the tour.
 */

import {
  OnboardingEvent,
  OnboardingRejection,
} from "@repo/api/src/types/onboarding-events";
import {
  createInitialOnboardingState,
  type OnboardingMachineState,
  OnboardingPhase,
} from "@repo/api/src/types/onboarding-phase";
import { transitionOnboarding } from "@repo/app/onboarding/lib/onboarding-transitions";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { GUEST_ONBOARDING_CONTEXT } from "../guest-onboarding-context";
import { settleGuestRunToReady } from "../settle-guest-run-to-ready";

// Spied, not replaced: the machine still decides every edge, and the spy is
// what shows WHICH edges the fold took.
vi.mock("@repo/app/onboarding/lib/onboarding-transitions", async (original) => {
  const actual =
    await original<
      typeof import("@repo/app/onboarding/lib/onboarding-transitions")
    >();
  return {
    ...actual,
    transitionOnboarding: vi.fn(actual.transitionOnboarding),
  };
});

beforeEach(() => {
  vi.mocked(transitionOnboarding).mockClear();
});

describe("settleGuestRunToReady", () => {
  it("leaves a run already at Ready as it is", () => {
    const ready = stateAt(OnboardingPhase.Ready, [
      OnboardingPhase.DashboardAvailable,
    ]);

    expect(settleGuestRunToReady(ready, context(true))).toEqual({
      state: ready,
      status: "moved",
    });
    expect(eventsPosted()).toEqual([]);
  });

  it("enters the dashboard straight to Ready once the tour is behind the guest", () => {
    const result = settleGuestRunToReady(
      stateAt(OnboardingPhase.DashboardAvailable),
      context(true)
    );

    expect(phaseOf(result)).toBe(OnboardingPhase.Ready);
    expect(eventsPosted()).toEqual([OnboardingEvent.DashboardEntered]);
  });

  it("defers a tour the guest is still owed rather than finishing it", () => {
    const result = settleGuestRunToReady(
      stateAt(OnboardingPhase.DashboardAvailable),
      context(false)
    );

    expect(phaseOf(result)).toBe(OnboardingPhase.Ready);
    expect(eventsPosted()).toEqual([
      OnboardingEvent.DashboardEntered,
      OnboardingEvent.DeferTour,
    ]);
  });

  it("defers from the tour phase itself", () => {
    const result = settleGuestRunToReady(
      stateAt(OnboardingPhase.DashboardTour, [
        OnboardingPhase.DashboardAvailable,
      ]),
      context(false)
    );

    expect(phaseOf(result)).toBe(OnboardingPhase.Ready);
    expect(eventsPosted()).toEqual([OnboardingEvent.DeferTour]);
  });

  it("refuses a run still in the blocking flow", () => {
    const result = settleGuestRunToReady(
      stateAt(OnboardingPhase.Account, [
        OnboardingPhase.Welcome,
        OnboardingPhase.SessionDiscovery,
      ]),
      context(false)
    );

    expect(result).toEqual({
      reason: OnboardingRejection.NotAllowedFromPhase,
      status: "rejected",
    });
    expect(eventsPosted()).toEqual([]);
  });
});

function context(tourCompleted: boolean) {
  return { ...GUEST_ONBOARDING_CONTEXT, tourCompleted };
}

function stateAt(
  phase: OnboardingPhase,
  history: OnboardingPhase[] = []
): OnboardingMachineState {
  return { ...createInitialOnboardingState(), history, phase };
}

function phaseOf(
  result: ReturnType<typeof settleGuestRunToReady>
): OnboardingPhase | undefined {
  return result.status === "moved" ? result.state.phase : undefined;
}

function eventsPosted(): string[] {
  return vi
    .mocked(transitionOnboarding)
    .mock.calls.map(([, event]) => event.type);
}
