/**
 * The onboarding machine's tour exits: where a `finish_tour` completion may be
 * recorded from, and which of the two tour exits `Ready` accepts.
 */

import {
  OnboardingEvent,
  OnboardingRejection,
} from "@repo/api/src/types/onboarding-events";
import { OnboardingPhase } from "@repo/api/src/types/onboarding-phase";
import { describe, expect, it } from "vitest";
import { transitionOnboarding } from "../onboarding-transitions";
import { context, stateAt } from "./onboarding-transitions-test-helpers";

/**
 * PLN-1875 Step 9. `finish_tour` was the only edge out of `dashboard_tour`, so
 * an org with no synced sessions — whose dashboard emits no anchor to ring —
 * could not leave the phase at all without being recorded as having seen a tour
 * it was never shown. `defer_tour` is the exit that records nothing, and the
 * completion it leaves owed is what `Ready` now accepts once the data arrives.
 *
 * That `defer_tour` reaches `Ready` at all is the `DashboardTour --> PendingStep`
 * row in `DIAGRAM_EDGES`; that it stamps no marker is `apps/api`’s
 * transition-service suite. Neither is observable from here, so what this block
 * pins is only the half the machine decides: which exits `Ready` accepts.
 */
describe("where a tour completion may be recorded from", () => {
  const ALL_PHASES: readonly OnboardingPhase[] = Object.values(OnboardingPhase);

  it("accepts the completion from every phase while the tour is unrecorded", () => {
    // Desktop's tour fires on FIRST LAUNCH, not on the run, so the phase the run
    // happens to sit on is not the reader's answer to give. Nothing in
    // production posts `dashboard_entered`, which parks those runs on `Welcome`
    // (no attempt row yet) or `DashboardAvailable` — the completion had no edge
    // from either, so it was refused with no signal and web went on offering the
    // tour. Exhaustive over the phase list so a phase added later cannot fall
    // back out.
    const refusing = ALL_PHASES.filter(
      (phase) =>
        transitionOnboarding(
          stateAt(phase),
          { type: OnboardingEvent.FinishTour },
          context({ tourCompleted: false })
        ).status !== "moved"
    );

    expect(refusing).toEqual([]);
  });

  it("blocks the completion from every phase once the run has recorded one", () => {
    // The counterfactual for the case above, over the same list and moving only
    // `tourCompleted`. `dashboard_tour` is deliberately excluded: it is the one
    // phase where `finish_tour` is also an EXIT, and a run stranded there with
    // no edge out is the trap this step exists to close — so the marker guard
    // must not be what strands it.
    const moving = ALL_PHASES.filter(
      (phase) =>
        phase !== OnboardingPhase.DashboardTour &&
        transitionOnboarding(
          stateAt(phase),
          { type: OnboardingEvent.FinishTour },
          context({ tourCompleted: true })
        ).status === "moved"
    );

    expect(moving).toEqual([]);
  });

  it("leaves a run parked short of the tour exactly where it was", () => {
    // Where a finished blocking flow actually rests. The marker is the whole
    // point of the transition; appending `DashboardAvailable` to its own history
    // would write a chain no run can walk and the next restore would discard it.
    const parked = stateAt(OnboardingPhase.DashboardAvailable);

    const result = transitionOnboarding(
      parked,
      { type: OnboardingEvent.FinishTour },
      context({ tourCompleted: false })
    );

    expect(result).toEqual({ status: "moved", state: parked });
  });

  it("still refuses to DEFER from a phase that has no tour to leave", () => {
    // The asymmetry, and what keeps the case above from reading as "any tour
    // event is accepted anywhere": a deferral's whole effect is leaving
    // `dashboard_tour`, so it has nothing to do from the phase before it.
    const result = transitionOnboarding(
      stateAt(OnboardingPhase.DashboardAvailable),
      { type: OnboardingEvent.DeferTour },
      context({ tourCompleted: false })
    );

    expect(result).toEqual({
      status: "rejected",
      reason: OnboardingRejection.NotAllowedFromPhase,
    });
  });
});

describe("which of the two tour exits Ready accepts", () => {
  it("accepts the completion from Ready while the tour is still owed", () => {
    const result = transitionOnboarding(
      stateAt(OnboardingPhase.Ready, {
        history: [
          OnboardingPhase.DashboardAvailable,
          OnboardingPhase.DashboardTour,
        ],
      }),
      { type: OnboardingEvent.FinishTour },
      context({ tourCompleted: false })
    );

    // The reader does not MOVE: they were already at rest. Appending Ready to
    // its own history would write a chain no run can walk, and the next restore
    // would throw the run away.
    expect(result).toEqual({
      status: "moved",
      state: stateAt(OnboardingPhase.Ready, {
        history: [
          OnboardingPhase.DashboardAvailable,
          OnboardingPhase.DashboardTour,
        ],
      }),
    });
  });

  it("blocks a second completion once the run has recorded one", () => {
    // Identical state to the case above; `tourCompleted` is the only difference.
    const result = transitionOnboarding(
      stateAt(OnboardingPhase.Ready, {
        history: [
          OnboardingPhase.DashboardAvailable,
          OnboardingPhase.DashboardTour,
        ],
      }),
      { type: OnboardingEvent.FinishTour },
      context({ tourCompleted: true })
    );

    expect(result).toEqual({
      status: "rejected",
      reason: OnboardingRejection.GuardBlocked,
    });
  });

  it("refuses to defer a run that has already left the tour phase", () => {
    const result = transitionOnboarding(
      stateAt(OnboardingPhase.Ready),
      { type: OnboardingEvent.DeferTour },
      context({ tourCompleted: false })
    );

    expect(result).toEqual({
      status: "rejected",
      reason: OnboardingRejection.NotAllowedFromPhase,
    });
  });
});
