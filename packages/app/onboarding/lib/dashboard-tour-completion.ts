/**
 * @file dashboard-tour-completion.ts
 * @description What "done" means for the Dashboard spotlight tour, in one place
 * (PLN-1875 Step 9).
 *
 * Two records claim a reader has seen the tour: the server's `tourCompleted`
 * (from `attempt.tourCompletedAt`) and desktop's `dashboardTourSeenStorageKey`
 * in `localStorage`. Nothing reconciled them, and nothing distinguished the
 * reader who FINISHED the tour from the reader who was never shown one. This
 * module is that distinction, and every consumer reads it rather than
 * re-deriving one:
 *
 *  - {@link dashboardTourOutcome} maps how a run ended onto which of the two it
 *    was;
 *  - {@link dashboardTourExitEvent} maps that onto the transition that exits the
 *    phase, so no host can pick the wrong one;
 *  - {@link isDashboardTourRequestedByRun} is the cross-device answer;
 *  - {@link dashboardTourStandingHere} adds this device's offline fast path, and
 *    keeps a still-arriving read distinct from both answers;
 *  - {@link canRecordDashboardTourCompletion} is the write-side twin of that
 *    standing, and is phase-blind for the same reason it is.
 *
 * PRECEDENCE, stated once. The SERVER record is authoritative across devices:
 * a reader who finished the tour on one device is not shown it on another, and
 * no local flag can resurrect a tour the server says is finished. The local flag
 * is a SAME-DEVICE fast path that suppresses without a round trip, which is what
 * keeps desktop working offline. Neither record can un-finish the other — both
 * only ever end the tour, never re-open it.
 */

import {
  OnboardingEvent,
  type OnboardingEventInput,
} from "@repo/api/src/types/onboarding-events";
import { OnboardingPhase } from "@repo/api/src/types/onboarding-phase";
import { TourCloseReason } from "../components/dashboard-tour/dashboard-tour-types";

/**
 * What a finished tour run actually recorded.
 *
 * The whole point of the split: only {@link DashboardTourOutcome.Completed}
 * means the reader was shown the tour, and only it suppresses a later showing on
 * another device. {@link DashboardTourOutcome.Unshown} still has to exit the
 * phase — a run that showed nothing cannot leave the reader parked on it — but
 * it leaves the tour owed.
 */
export const DashboardTourOutcome = {
  /** The reader was shown the tour and ended it. */
  Completed: "completed",
  /** The run ended without showing anything, so the tour is still owed. */
  Unshown: "unshown",
} as const;
export type DashboardTourOutcome =
  (typeof DashboardTourOutcome)[keyof typeof DashboardTourOutcome];

/**
 * Exhaustive over {@link TourCloseReason} so a new way for a run to end has to
 * declare which of the two it is, rather than falling to whichever branch an
 * `if` happens to leave last.
 */
const OUTCOME_BY_CLOSE_REASON: Record<TourCloseReason, DashboardTourOutcome> = {
  [TourCloseReason.Done]: DashboardTourOutcome.Completed,
  [TourCloseReason.Skip]: DashboardTourOutcome.Completed,
  [TourCloseReason.Empty]: DashboardTourOutcome.Unshown,
};

/**
 * Which of the two a run that closed for `reason` was.
 *
 * `Skip` is a completion: the reader saw the tour and chose to leave it, which
 * is an answer. `Empty` is not — nothing was ever painted, so there was nothing
 * to answer.
 */
export function dashboardTourOutcome(
  reason: TourCloseReason
): DashboardTourOutcome {
  return OUTCOME_BY_CLOSE_REASON[reason];
}

/**
 * Exhaustive over {@link DashboardTourOutcome}: the transition each outcome
 * exits the tour phase with. Both exit; only `finish_tour` stamps the record.
 */
const EXIT_EVENT_BY_OUTCOME: Record<
  DashboardTourOutcome,
  OnboardingEventInput
> = {
  [DashboardTourOutcome.Completed]: { type: OnboardingEvent.FinishTour },
  [DashboardTourOutcome.Unshown]: { type: OnboardingEvent.DeferTour },
};

/** The transition that ends a run with this outcome. */
export function dashboardTourExitEvent(
  outcome: DashboardTourOutcome
): OnboardingEventInput {
  return EXIT_EVENT_BY_OUTCOME[outcome];
}

/** What the guided-onboarding run says about this reader's tour. */
export type DashboardTourRunRecord = {
  /**
   * The phase the run is parked on, or `null` when this surface has no run to
   * read — the read is in flight, gated off, or came back unreadable.
   *
   * `null` is an ANSWERLESS record, and {@link isDashboardTourRequestedByRun}
   * fails safe on it in the direction that costs least: it never REQUESTS the
   * tour, so a failed read cannot open a scrim over every reader. Suppression is
   * not this record's to give — see {@link dashboardTourStandingHere}, which
   * reads the completion record and never the phase.
   */
  phase: OnboardingPhase | null;
  /** The server's cross-device completion record. */
  tourCompleted: boolean;
};

/**
 * What {@link isDashboardTourRequestedByRun} needs on top of the run record.
 *
 * Its own type because only the ARM asks this. The write guard and the machine
 * read a {@link DashboardTourRunRecord} and neither can answer it — the machine
 * is pure and has no notion of a stored row — so folding the field into the
 * shared record would make both invent a value.
 */
export type DashboardTourArmRecord = DashboardTourRunRecord & {
  /**
   * Whether a run is actually STORED for this account — an `OnboardingAttempt`
   * row exists.
   *
   * Load-bearing, not informational. `Ready` is reported two ways the phase
   * alone cannot tell apart: a run that genuinely deferred its tour, and the
   * synthetic settled run the server reports for an account that finished
   * onboarding before the guided flow shipped and so has no row at all
   * (`guidedOnboardingSnapshotService`, ISS-9916). Only the first is owed a
   * tour — nothing deferred one for the second, and arming it there would hand
   * a six-step spotlight to every legacy-complete organization and let its exit
   * materialise the very row whose absence defines the population.
   *
   * A first accepted transition is what creates the row, so a genuine deferral
   * always has one.
   */
  runStored: boolean;
};

/**
 * Exhaustive over {@link OnboardingPhase}: whether the tour is still outstanding
 * from each phase.
 *
 * A hand-written `readonly OnboardingPhase[]` was the side-inventory shape this
 * repo's review lessons name — typing the element rejects a typo, but a list
 * built from today's members still compiles when a phase is ADDED, so the new
 * phase silently falls to "not owing" and both predicates plus the machine's
 * `Ready` arm change their answer with nothing failing. A `Record` cannot be
 * written without naming every member, so the new phase fails `tsc` instead.
 *
 * `DashboardTour` is the run waiting to be shown; `Ready` is a run that already
 * deferred one — the only way to be at rest still owing it — and is what lets a
 * zero-session org see the completion card now and the tour when its data lands.
 * Every other phase is the blocking flow, which routes to the tour itself once
 * the Dashboard is reached: not asking YET, which is not the same as finished.
 */
const TOUR_OWED_BY_PHASE: Record<OnboardingPhase, boolean> = {
  [OnboardingPhase.Welcome]: false,
  [OnboardingPhase.SessionDiscovery]: false,
  [OnboardingPhase.Account]: false,
  [OnboardingPhase.CreateOrganization]: false,
  [OnboardingPhase.ChooseOrganization]: false,
  [OnboardingPhase.SyncPolicy]: false,
  [OnboardingPhase.InviteTeam]: false,
  [OnboardingPhase.DownloadDesktop]: false,
  [OnboardingPhase.ConnectGitHub]: false,
  [OnboardingPhase.DashboardAvailable]: false,
  [OnboardingPhase.DashboardTour]: true,
  [OnboardingPhase.Ready]: true,
};

/**
 * Whether the RUN is asking for the tour right now — the cross-device answer,
 * and the one web's host opens its tour by itself on.
 *
 * NOT a write guard. Recording an exit asks a different question — see
 * {@link canRecordDashboardTourCompletion} — and answering it from here is what
 * made the arm and the write disagree.
 *
 * A run still inside the blocking flow is not asking: the flow routes to the
 * tour itself once the Dashboard is reached. An ANSWERLESS run is not asking
 * either, which is what keeps a slow or failed snapshot read from opening the
 * tour over a reader whose run was never on it. Nor is an UNSTORED one — see
 * {@link DashboardTourRunRecord.runStored}.
 */
export function isDashboardTourRequestedByRun({
  phase,
  runStored,
  tourCompleted,
}: DashboardTourArmRecord): boolean {
  if (phase === null || tourCompleted || !runStored) {
    return false;
  }
  return TOUR_OWED_BY_PHASE[phase];
}

/**
 * What a surface with its OWN trigger for the tour should do about it — the
 * three answers, kept apart because a boolean cannot carry them.
 *
 * The one that gets lost is {@link DashboardTourStanding.Unread}. Desktop's
 * consumer does not merely SKIP on a not-owed answer: it writes the permanent
 * `dashboardOnboardedStorageKey` latch, so a momentary "not right now" becomes
 * "never on this install". A two-valued answer has to fold the still-arriving
 * read into one of the other two, and both folds are wrong — fold it to done and
 * a slow read retires a tour the reader never saw, fold it to owed and the
 * cross-device suppression this module exists for loses its race with the arm.
 */
export const DashboardTourStanding = {
  /** This reader is finished with the tour. Suppress it, durably. */
  Done: "done",
  /** The tour is outstanding for this reader. Show it. */
  Owed: "owed",
  /** No answer yet. Neither show it nor retire it — wait. */
  Unread: "unread",
} as const;
export type DashboardTourStanding =
  (typeof DashboardTourStanding)[keyof typeof DashboardTourStanding];

/**
 * THE DEFINITION OF DONE, for a surface that has its own trigger for the tour.
 *
 * Desktop's tour predates the guided run and fires on first launch, so "should I
 * show it" cannot be the run's question there the way it is on web — but "is
 * this reader finished with it" is, and this is that answer. It is done two
 * ways, and only these two:
 *
 *  - THIS DEVICE has already shown it (`dashboardTourSeenStorageKey`). No round
 *    trip, which is what keeps desktop suppressing correctly offline.
 *  - THE RUN recorded the tour complete, wherever that happened.
 *
 * THE RUN'S PHASE IS DELIBERATELY NOT READ HERE, and that is the correction this
 * function carries. It used to answer `!isDashboardTourRequestedByRun(...)`,
 * which made every phase outside the owing set — the whole blocking flow, and
 * `DashboardAvailable`, where a run with no `dashboard_entered` producer parks —
 * read as DONE. On a surface that latches, "the run is not asking yet" is not an
 * answer it may act on; per the precedence above, the run may only ever END the
 * tour, never withhold it. Only `tourCompleted` says it ended.
 *
 * An unread run is NOT an answer either way, and `runRead` is what separates it
 * from a run that answered with no completion record.
 */
export function dashboardTourStandingHere({
  localSeen,
  runRead,
  tourCompleted,
}: {
  /** This device's `dashboardTourSeenStorageKey`-style record. */
  localSeen: boolean;
  /**
   * Whether the guided run has ANSWERED for this surface — resolved, failed, or
   * never asked for. `false` only while a read this surface is waiting on is
   * still in flight, so a surface with no run to read is not held shut forever.
   */
  runRead: boolean;
  /** The server's cross-device completion record. */
  tourCompleted: boolean;
}): DashboardTourStanding {
  // Checked before `runRead`: the same-device fast path is what keeps desktop
  // suppressing with no round trip at all, including offline.
  if (localSeen) {
    return DashboardTourStanding.Done;
  }
  if (!runRead) {
    return DashboardTourStanding.Unread;
  }
  return tourCompleted
    ? DashboardTourStanding.Done
    : DashboardTourStanding.Owed;
}

/**
 * THE WRITE-SIDE TWIN OF {@link dashboardTourStandingHere}, and phase-blind for
 * the same reason it is.
 *
 * A completion is a fact about the READER — they were shown the tour and ended
 * it — so the only thing that can make it not worth recording is a record that
 * already says so. Reading the phase here is what made the two disagree: the
 * standing shows the tour to a run parked anywhere, and this refused to record
 * the answer unless the run had reached the tour phase. Since nothing in
 * production posts `dashboard_entered`, every desktop reader's run sits on
 * `Welcome` (no attempt row yet) or `DashboardAvailable` — so the completion the
 * reader gave was dropped for almost all of them, with no signal, and web went
 * on offering a tour they had already finished.
 *
 * `TOUR_OWED_BY_PHASE` is deliberately NOT consulted. It answers whether the RUN
 * is asking, which is a different question and the one the web arm needs; a
 * completion arriving from a phase that is not asking is exactly the desktop
 * case above, not an error.
 */
export function canRecordDashboardTourCompletion({
  phase,
  tourCompleted,
}: DashboardTourRunRecord): boolean {
  return phase !== null && !tourCompleted;
}

/**
 * Whether a DEFERRAL still has something to record, which is the asymmetric
 * half.
 *
 * A deferral records no marker at all — its whole effect is leaving the tour
 * phase — so it is worth posting from exactly the one phase that has that edge.
 * From anywhere else it would spend a revision to move nowhere, and the machine
 * refuses it.
 */
function canRecordDashboardTourDeferral({
  phase,
  tourCompleted,
}: DashboardTourRunRecord): boolean {
  return phase === OnboardingPhase.DashboardTour && !tourCompleted;
}

/**
 * Exhaustive over {@link DashboardTourOutcome}: what each exit needs of the run
 * before it is worth posting.
 */
const EXIT_RECORDABILITY_BY_OUTCOME: Record<
  DashboardTourOutcome,
  (record: DashboardTourRunRecord) => boolean
> = {
  [DashboardTourOutcome.Completed]: canRecordDashboardTourCompletion,
  [DashboardTourOutcome.Unshown]: canRecordDashboardTourDeferral,
};

/**
 * Whether ending a run this way has anything left to record on the server.
 *
 * Every `false` this can now answer means there is NOTHING TO RECORD — no run to
 * record against, a completion the run already carries, or a deferral from a
 * phase the run has already left. It no longer refuses a completion the reader
 * actually gave, which is what made a dropped write indistinguishable from a
 * landed one.
 */
export function canRecordDashboardTourExit(
  outcome: DashboardTourOutcome,
  record: DashboardTourRunRecord
): boolean {
  return EXIT_RECORDABILITY_BY_OUTCOME[outcome](record);
}
