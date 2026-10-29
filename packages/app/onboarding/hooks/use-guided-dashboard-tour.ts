"use client";

/**
 * @file use-guided-dashboard-tour.ts
 * @description What a dashboard tour host needs from the guided onboarding run
 * (PLN-1875 Steps 8 and 9): whether this reader is still owed the tour, and the
 * two writes that end a run.
 *
 * Kept beside the generic client rather than inside `apps/app` because Step 9's
 * tour-seen reconciliation needs the same snapshot on desktop, and a hook built
 * inside the web app cannot be reached from the renderer.
 */

import type { OnboardingHost } from "@repo/api/src/types/onboarding-phase";
import { WorkspaceExperience } from "@repo/api/src/types/workspace-experience";
import { useCallback } from "react";
import {
  canRecordDashboardTourExit,
  DashboardTourOutcome,
  type DashboardTourStanding,
  dashboardTourExitEvent,
  dashboardTourStandingHere,
  isDashboardTourRequestedByRun,
} from "../lib/dashboard-tour-completion";
import { isGuidedOnboardingEventRefused } from "../lib/guided-onboarding-event-support";
import {
  useGuidedOnboardingSnapshot,
  useGuidedOnboardingTransition,
} from "./use-guided-onboarding";

export type GuidedDashboardTour = {
  /**
   * Whether the RUN is asking for the tour — web's trigger for opening the tour
   * by itself, as against its reader pressing Tour. `false` while the read
   * is in flight, gated off, or unreadable, so an unanswered read can never open
   * a scrim over a reader whose run was never on the tour.
   */
  tourRequested: boolean;
  /**
   * What a surface with its OWN trigger for the tour should do about it — the
   * three-valued answer in `dashboard-tour-completion.ts`, and the whole
   * suppression answer for desktop's first launch. `Unread` while a read this
   * host is waiting on is still in flight, so nothing retires the tour on a
   * missing read AND nothing opens one the run may be about to suppress.
   */
  tourStanding: DashboardTourStanding;
  /** Record that the tour was shown and ended. A no-op when it is not owed. */
  finishTour: () => void;
  /**
   * Record that the run ended without showing anything. A no-op when it is not
   * owed, and deliberately NOT `finishTour` for an empty run: that would retire
   * the tour for the exact cohort it exists for.
   */
  deferTour: () => void;
};

/**
 * The tour's read of the guided onboarding run.
 *
 * THE TWO WRITES ARE GATED ON THE RUN, NOT ON THE DEVICE. `localSeen` narrows
 * what this device SHOWS; it must not narrow what this device REPORTS, or a
 * desktop replay of an already-seen tour would leave the server record
 * permanently unwritten and web would keep offering the tour forever.
 */
export function useGuidedDashboardTour({
  analysisStarted,
  host,
  localSeen,
}: {
  /** See `useGuidedOnboardingTransition` — the caller states its own value. */
  analysisStarted: boolean;
  host: OnboardingHost;
  /**
   * This device's own "already seen" record. Desktop keeps one
   * (`dashboardTourSeenStorageKey`); web keeps none and passes `false`.
   */
  localSeen: boolean;
}): GuidedDashboardTour {
  const { data: snapshot, isLoading } = useGuidedOnboardingSnapshot(host);
  const { mutate } = useGuidedOnboardingTransition({
    analysisStarted,
    experienceVariant: WorkspaceExperience.V2,
    host,
  });

  const run = {
    phase: snapshot?.state.phase ?? null,
    // A `Ready` with no attempt row is the server's synthetic settled run for an
    // account onboarded before the guided flow, not a deferred tour.
    runStored: snapshot?.attemptId != null,
    tourCompleted: snapshot?.context.tourCompleted ?? false,
  };
  // A gated-off read is READ in the only sense a caller can act on: nothing is
  // coming, so waiting on it would hold a legacy host's own tour shut for the
  // session. `isPending` cannot say that — TanStack reports a disabled query as
  // pending forever, which is the same value it reports for a request genuinely
  // in flight.
  //
  // SO THE ANSWER IS TAKEN FROM THE QUERY, never re-modelled here. ANDing
  // `snapshotEnabled` onto `isPending` modelled only THIS hook's half of the
  // gate: `useGuidedOnboardingSnapshot` ANDs an identity gate
  // (`isLoaded && userId !== null`) on top that no caller can see, so a settled
  // v2 with no identity — a signed-out or provider-less tree, which is what
  // `useOptionalAuthSnapshot` resolves to — waited on a request that was never
  // issued and so could never resolve or fail. `Unread` latched, and desktop's
  // arm returned early forever: no tour, and no `dashboardOnboardedStorageKey`.
  // `isLoading` is `isPending && isFetching`, true only while a request is
  // genuinely in flight and will answer, so a read gated off on EITHER side —
  // or paused offline — is answered. That applies the rule above to every gate
  // rather than to the one this hook happens to own.
  const runUnread = isLoading;

  const end = useCallback(
    (outcome: DashboardTourOutcome) => {
      if (!snapshot) {
        return;
      }
      const recordable = canRecordDashboardTourExit(outcome, {
        phase: snapshot.state.phase,
        tourCompleted: snapshot.context.tourCompleted,
      });
      if (!recordable) {
        return;
      }
      const event = dashboardTourExitEvent(outcome);
      // The skew arm. `defer_tour` is new on the wire and `apps/app` deploys
      // separately from `apps/api`, so this build can reach an API whose schema
      // rejects it — and the re-read that follows returns the run UNCHANGED, so
      // the arm fires and defers again on every visit. Falling back to
      // `finish_tour` is the one thing that must not happen here: it would retire
      // a tour the reader was never shown, which is what this step exists to
      // stop. Posting nothing leaves the tour owed, which is the pre-Step-9
      // behaviour and the honest one.
      if (isGuidedOnboardingEventRefused(event.type)) {
        return;
      }
      mutate({ event, snapshot });
    },
    [mutate, snapshot]
  );

  const finishTour = useCallback(
    () => end(DashboardTourOutcome.Completed),
    [end]
  );
  const deferTour = useCallback(() => end(DashboardTourOutcome.Unshown), [end]);

  return {
    deferTour,
    finishTour,
    tourStanding: dashboardTourStandingHere({
      localSeen,
      runRead: !runUnread,
      tourCompleted: run.tourCompleted,
    }),
    tourRequested: isDashboardTourRequestedByRun(run),
  };
}
