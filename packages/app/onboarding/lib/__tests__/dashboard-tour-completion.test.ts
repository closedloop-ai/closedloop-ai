/**
 * PLN-1875 Step 9 — the one definition of what "done" means for the dashboard
 * tour, and the two answers every consumer reads off it.
 *
 * Each case pins ONE discriminator, and the fixtures are built so nothing else
 * moves between the arms: the run cases hold the phase fixed and move only
 * `tourCompleted`, and the standing cases move exactly one field per adjacent
 * pair. A pair that differed in two fields would go green on either.
 */

import { OnboardingEvent } from "@repo/api/src/types/onboarding-events";
import { OnboardingPhase } from "@repo/api/src/types/onboarding-phase";
import { describe, expect, it } from "vitest";
import { TourCloseReason } from "../../components/dashboard-tour/dashboard-tour-types";
import {
  canRecordDashboardTourExit,
  DashboardTourOutcome,
  DashboardTourStanding,
  dashboardTourExitEvent,
  dashboardTourOutcome,
  dashboardTourStandingHere,
  isDashboardTourRequestedByRun,
} from "../dashboard-tour-completion";

describe("what a close reason recorded", () => {
  it("counts Done and Skip as the reader completing the tour", () => {
    expect(dashboardTourOutcome(TourCloseReason.Done)).toBe(
      DashboardTourOutcome.Completed
    );
    // Leaving early is an ANSWER: the reader saw the tour and chose to stop.
    expect(dashboardTourOutcome(TourCloseReason.Skip)).toBe(
      DashboardTourOutcome.Completed
    );
  });

  it("counts a run that painted nothing as unshown", () => {
    expect(dashboardTourOutcome(TourCloseReason.Empty)).toBe(
      DashboardTourOutcome.Unshown
    );
  });

  it("exits an unshown run with defer_tour, never finish_tour", () => {
    // The whole point of the split: `finish_tour` is the only event that stamps
    // the completion record, so routing an unshown run through it would retire
    // the tour for a reader who saw none of it.
    expect(dashboardTourExitEvent(DashboardTourOutcome.Unshown)).toEqual({
      type: OnboardingEvent.DeferTour,
    });
    expect(dashboardTourExitEvent(DashboardTourOutcome.Completed)).toEqual({
      type: OnboardingEvent.FinishTour,
    });
  });
});

describe("whether the run is asking for the tour", () => {
  it("asks while the run is parked on the tour phase", () => {
    expect(
      isDashboardTourRequestedByRun({
        phase: OnboardingPhase.DashboardTour,
        runStored: true,
        tourCompleted: false,
      })
    ).toBe(true);
  });

  it("still asks from the Ready a deferred run left it on", () => {
    // The zero-session reader: at rest, completion card visible, tour still
    // owed. Without this the deferral would silently retire the tour.
    expect(
      isDashboardTourRequestedByRun({
        phase: OnboardingPhase.Ready,
        runStored: true,
        tourCompleted: false,
      })
    ).toBe(true);
  });

  it("stops asking once the completion record is set", () => {
    // Same phase as the case above; `tourCompleted` is the only thing that moved.
    expect(
      isDashboardTourRequestedByRun({
        phase: OnboardingPhase.Ready,
        runStored: true,
        tourCompleted: true,
      })
    ).toBe(false);
  });

  it("does not ask from a phase the blocking flow still owns", () => {
    expect(
      isDashboardTourRequestedByRun({
        phase: OnboardingPhase.Account,
        runStored: true,
        tourCompleted: false,
      })
    ).toBe(false);
  });

  it("does not ask from the Dashboard the run has not been routed off", () => {
    // `DashboardAvailable` is the diagram's transient `Complete`, and its only
    // edge out is `dashboard_entered`. Named on its own because it is the phase
    // a finished blocking flow actually parks on, so "transient" is where the
    // owed set is most tempting to get wrong.
    expect(
      isDashboardTourRequestedByRun({
        phase: OnboardingPhase.DashboardAvailable,
        runStored: true,
        tourCompleted: false,
      })
    ).toBe(false);
  });

  it("does not ask from the synthetic Ready of an account with no stored run", () => {
    // ISS-9916. `guidedOnboardingSnapshotService` reports a settled run for an
    // organization that finished onboarding before the guided flow shipped, so
    // it has no `OnboardingAttempt` row and `tourCompleted` is false for want
    // of one — the exact pair the deferred case above carries. Only
    // `runStored` separates them, and arming here would put a six-step
    // spotlight over every legacy-complete organization and let its exit write
    // the very row whose absence defines the population.
    expect(
      isDashboardTourRequestedByRun({
        phase: OnboardingPhase.Ready,
        runStored: false,
        tourCompleted: false,
      })
    ).toBe(false);
  });

  it("does not ask on an answerless run", () => {
    // A read in flight, gated off, or failed. Treating it as a yes would open a
    // full-screen scrim over every reader whose snapshot request lost.
    expect(
      isDashboardTourRequestedByRun({
        phase: null,
        runStored: true,
        tourCompleted: false,
      })
    ).toBe(false);
  });
});

/**
 * Four inputs, arranged so each adjacent pair moves exactly ONE field: A→B moves
 * `localSeen`, B→C moves `runRead`, C→D moves `tourCompleted`, D→E moves
 * `runRead` back. Nothing here can go green on a field it does not name.
 */
describe("where this device's tour stands", () => {
  it("is done when this device has already shown it, before any read lands", () => {
    // The same-device fast path, checked ahead of the read: this is the
    // suppression that has to work with no server call at all, offline.
    expect(
      dashboardTourStandingHere({
        localSeen: true,
        runRead: false,
        tourCompleted: false,
      })
    ).toBe(DashboardTourStanding.Done);
  });

  it("has no answer while the run is still being read", () => {
    // Identical to the case above; `localSeen` is the only thing that moved. A
    // surface that latches must not act on this — see `use-tour-arming.ts`.
    expect(
      dashboardTourStandingHere({
        localSeen: false,
        runRead: false,
        tourCompleted: false,
      })
    ).toBe(DashboardTourStanding.Unread);
  });

  it("owes the tour once the run answers with no completion record", () => {
    // Identical to the case above; `runRead` is the only thing that moved. This
    // is desktop's legacy and offline branch and every run that has not reached
    // the tour yet — nothing has said the tour is over, so it is still owed.
    expect(
      dashboardTourStandingHere({
        localSeen: false,
        runRead: true,
        tourCompleted: false,
      })
    ).toBe(DashboardTourStanding.Owed);
  });

  it("is done when the run finished it on another device", () => {
    // The cross-device half, and identical to the case above but for
    // `tourCompleted`: no local flag here, so the server record is the only
    // thing that can suppress the re-show.
    expect(
      dashboardTourStandingHere({
        localSeen: false,
        runRead: true,
        tourCompleted: true,
      })
    ).toBe(DashboardTourStanding.Done);
  });

  it("does not claim done from a completion record that has not arrived", () => {
    // Identical to the case above; `runRead` is the only thing that moved. The
    // arm race in one line: the reader IS finished, and a two-valued answer
    // would have to say `owed` here and open the tour before the read landed.
    expect(
      dashboardTourStandingHere({
        localSeen: false,
        runRead: false,
        tourCompleted: true,
      })
    ).toBe(DashboardTourStanding.Unread);
  });
});

describe("which exits are worth recording", () => {
  it("records a completion from every phase a run can be parked on", () => {
    // The arm and the write have to agree, and `dashboardTourStandingHere` shows
    // the tour to a run parked ANYWHERE with no completion record. Scoping the
    // write to the phases the run is asking from dropped the answer for almost
    // every desktop reader: nothing posts `dashboard_entered`, so their run sits
    // on `Welcome` or `DashboardAvailable`. Exhaustive over the phase list
    // rather than a sample, so a phase added later cannot quietly fall out.
    const refusing = Object.values(OnboardingPhase).filter(
      (phase) =>
        !canRecordDashboardTourExit(DashboardTourOutcome.Completed, {
          phase,
          tourCompleted: false,
        })
    );

    expect(refusing).toEqual([]);
  });

  it("records nothing once the run already carries the completion", () => {
    // The counterfactual for the case above, over the same phase list: with the
    // record set there is genuinely nothing left to write, and that is the ONLY
    // thing that may refuse a completion.
    const recording = Object.values(OnboardingPhase).filter((phase) =>
      canRecordDashboardTourExit(DashboardTourOutcome.Completed, {
        phase,
        tourCompleted: true,
      })
    );

    expect(recording).toEqual([]);
  });

  it("records neither exit against a run it has no answer for", () => {
    // An answerless read is not a run to write against, and `phase: null` is now
    // the only guard that says so for a completion.
    for (const outcome of Object.values(DashboardTourOutcome)) {
      expect(
        canRecordDashboardTourExit(outcome, {
          phase: null,
          tourCompleted: false,
        })
      ).toBe(false);
    }
  });

  it("records a completion from the Ready a deferred run left it on", () => {
    expect(
      canRecordDashboardTourExit(DashboardTourOutcome.Completed, {
        phase: OnboardingPhase.Ready,
        tourCompleted: false,
      })
    ).toBe(true);
  });

  it("does not re-defer a run that already left the tour phase", () => {
    // Same run as the case above. The deferral has nothing left to exit, so
    // posting it would spend a revision on a command the machine refuses.
    expect(
      canRecordDashboardTourExit(DashboardTourOutcome.Unshown, {
        phase: OnboardingPhase.Ready,
        tourCompleted: false,
      })
    ).toBe(false);
  });

  it("defers from the tour phase and from no other", () => {
    // The asymmetry, exhaustively: a deferral records no marker, so its whole
    // effect is leaving `dashboard_tour` — the one phase that has that edge. This
    // is what keeps the completion's phase-blindness from being copied onto the
    // exit that cannot use it.
    const deferring = Object.values(OnboardingPhase).filter((phase) =>
      canRecordDashboardTourExit(DashboardTourOutcome.Unshown, {
        phase,
        tourCompleted: false,
      })
    );

    expect(deferring).toEqual([OnboardingPhase.DashboardTour]);
  });

  it("records either exit from the tour phase itself", () => {
    for (const outcome of Object.values(DashboardTourOutcome)) {
      expect(
        canRecordDashboardTourExit(outcome, {
          phase: OnboardingPhase.DashboardTour,
          tourCompleted: false,
        })
      ).toBe(true);
    }
  });
});
