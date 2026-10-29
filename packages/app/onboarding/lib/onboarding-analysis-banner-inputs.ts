/**
 * @file The pure fold behind the ambient analysis bar (ISS-10492).
 *
 * The bar is `OnboardingAnalysisBanner`, promoted from the approved Web Master
 * v2 prototype, and this decides — from the run's phase and the host's measured
 * discovery — whether it belongs on screen and which of its two counts and its
 * percentage may be stated. It is ORTHOGONAL to `StartupReadinessPanel`: that
 * panel is a first-run readiness gate, this bar is ambient analysis progress
 * that reappears on nearly every login, and both can be on screen at once.
 *
 * Nothing here defaults a number. A count the host has not measured arrives as
 * `null` and leaves as `null`, because the banner omits an absent count and a
 * fabricated one would render as a measurement nobody took.
 */

import { OnboardingPhase } from "@repo/api/src/types/onboarding-phase";
import {
  analyzedCountFitsFound,
  type OnboardingAnalysisProgress,
  OnboardingAnalysisProgressStatus,
  type OnboardingSessionDiscovery,
} from "../components/guided-onboarding-data";

/** Percentage at which analysis has nothing left to report. */
const COMPLETE_PERCENT = 100;

/**
 * Whether a phase keeps the background analysis bar visible.
 *
 * Exhaustive over {@link OnboardingPhase} rather than a `readonly
 * OnboardingPhase[]` of the true ones: an array admits a subset, so a phase
 * added to the machine would compile here with no decision made and silently
 * fall to "no bar". The record makes the classification mandatory — a new phase
 * fails `tsc` until someone states which side it is on.
 *
 * The rows came from the prototype's own classification in
 * `ftue-progress-context.tsx`. `DashboardTour` and `Ready` have
 * no row over there because that prototype's `FtuePhase` stops at
 * `DashboardAvailable`; production runs on past it, and both are `true` for the
 * same reason `DashboardAvailable` is — the wizard has exited, the reader is
 * working in the shell, and analysis is still running behind them. That is the
 * case this bar exists for.
 */
const ANALYSIS_STATUS_PHASE = {
  [OnboardingPhase.Welcome]: false,
  [OnboardingPhase.SessionDiscovery]: false,
  [OnboardingPhase.Account]: true,
  [OnboardingPhase.CreateOrganization]: true,
  [OnboardingPhase.ChooseOrganization]: true,
  // The current flow reaches sync after Discovery. The resolver also checks
  // history because older persisted runs reached sync before Discovery.
  [OnboardingPhase.SyncPolicy]: true,
  [OnboardingPhase.DownloadDesktop]: false,
  [OnboardingPhase.InviteTeam]: true,
  [OnboardingPhase.ConnectGitHub]: true,
  [OnboardingPhase.DashboardAvailable]: true,
  [OnboardingPhase.DashboardTour]: true,
  [OnboardingPhase.Ready]: true,
} as const satisfies Record<OnboardingPhase, boolean>;

/**
 * Whether the reader has not yet authorized the analysis at this phase.
 *
 * NARROWER than {@link ANALYSIS_STATUS_PHASE}, and the two must not be
 * collapsed. That record answers whether the DERIVED bar belongs on screen, and
 * it is false for screens that draw their own progress — `SessionDiscovery` has
 * per-harness bars of its own, and the ambient host pass stays hidden until Continue advances
 * beyond it (ISS-11204). This record answers a different question: whether the reader has
 * agreed yet. On desktop only Welcome precedes that answer: its Start is what
 * releases the import (ISS-10950, as ruled for ISS-10890 on 2026-09-24).
 */
const PRE_ANALYSIS_CONSENT_PHASE = {
  [OnboardingPhase.Welcome]: true,
  [OnboardingPhase.SyncPolicy]: false,
  [OnboardingPhase.SessionDiscovery]: false,
  [OnboardingPhase.Account]: false,
  [OnboardingPhase.CreateOrganization]: false,
  [OnboardingPhase.ChooseOrganization]: false,
  [OnboardingPhase.DownloadDesktop]: false,
  [OnboardingPhase.InviteTeam]: false,
  [OnboardingPhase.ConnectGitHub]: false,
  [OnboardingPhase.DashboardAvailable]: false,
  [OnboardingPhase.DashboardTour]: false,
  [OnboardingPhase.Ready]: false,
} as const satisfies Record<OnboardingPhase, boolean>;

/**
 * Whether the run that governs the bar has been READ yet, which is a different
 * question from which phase it sits at (ISS-11279).
 *
 * `phase` alone cannot answer it. An absent phase used to mean one thing here —
 * the wizard has exited and the ambient bar is all that is left — and it means
 * two: that, and the run has not been read yet. Those want opposite answers, and
 * on a first launch it is always the second: the desktop startup pass goes
 * `active` 350ms after boot (`useStartupReadiness`), while the guest run is still
 * waiting on the auth bridge, so the override reached the bar and it drew itself
 * in over a dashboard whose takeover had not yet painted its first screen.
 */
export const OnboardingRunStanding = {
  /** Settled with no run governing this reader — a failed or absent read. */
  Absent: "absent",
  /** Read: the `phase` argument carries it. */
  Read: "read",
  /** Not read yet: in flight, or its source has not settled. */
  Unread: "unread",
} as const;
export type OnboardingRunStanding =
  (typeof OnboardingRunStanding)[keyof typeof OnboardingRunStanding];

/**
 * Whether a standing suppresses the bar on its own, before any phase is asked.
 *
 * `Absent` deliberately does NOT suppress, and that is the half this gate exists
 * to protect rather than an oversight: ISS-10492 made this bar the desktop's only
 * startup-progress surface, so a reader whose run read FAILED — offline, or a
 * server that has no run for them — must still be shown the pass they are
 * waiting on. Suppressing an unread run costs that reader the read's latency;
 * suppressing an absent one would cost them the surface entirely.
 *
 * A `Record` rather than one more `||` for the same reason as the two phase
 * records above: a standing added later cannot fall through to "show it".
 */
const SUPPRESSING_RUN_STANDING = {
  [OnboardingRunStanding.Absent]: false,
  [OnboardingRunStanding.Read]: false,
  [OnboardingRunStanding.Unread]: true,
} as const satisfies Record<OnboardingRunStanding, boolean>;

/** What {@link OnboardingAnalysisBanner} needs to render one frame. */
export type OnboardingAnalysisBannerInputs = {
  active: boolean;
  analyzed: number | null;
  found: number | null;
  percent: number | null;
};

export function isAnalysisStatusPhase(phase: OnboardingPhase): boolean {
  return ANALYSIS_STATUS_PHASE[phase];
}

export function isPreAnalysisConsentPhase(phase: OnboardingPhase): boolean {
  return PRE_ANALYSIS_CONSENT_PHASE[phase];
}

/**
 * The bar's four props, derived from what the host actually measured.
 *
 * `active` takes THREE axes, where the prototype took two. The third is
 * `settled`, the host's own terminal flag for the boot import, and it is not
 * redundant with `percent < 100`: a run that quarantines sources reaches a
 * terminal below 100%, so without this gate the bar sweeps forever claiming an
 * analysis that has already stopped.
 *
 * An UNMEASURED percentage is inactive rather than a sweeping bar. The bar
 * asserts "analysis is running"; a host that has not reported progress has not
 * told us that, and a sweep is a claim, not a blank.
 *
 * It also waits for {@link isDiscoveryReady}, so its first frame can state the
 * counter (ISS-11668 ruling 16).
 */
export function deriveAnalysisBannerInputs({
  discovery,
  phase,
  progress,
  settled,
}: {
  discovery: OnboardingSessionDiscovery;
  /** The run's current phase, or `undefined` before a run has been read. */
  phase: OnboardingPhase | undefined;
  progress: OnboardingAnalysisProgress;
  /** Whether the host's boot import reached one of its own terminals. */
  settled: boolean;
}): OnboardingAnalysisBannerInputs {
  const measured = discovery.status === "measured" ? discovery : null;
  const percent =
    progress.status === OnboardingAnalysisProgressStatus.Measured
      ? progress.percent
      : null;
  return {
    active:
      phase !== undefined &&
      isAnalysisStatusPhase(phase) &&
      percent !== null &&
      percent < COMPLETE_PERCENT &&
      !settled &&
      isDiscoveryReady(discovery),
    ...counterPair(measured),
    percent,
  };
}

/**
 * The banner's two counts, or `null` for both.
 *
 * The banner states them as a bare "X / Y" with no labels, which reads as a
 * fraction — so the pair may only be stated when the analyzed count actually
 * fits the found one ({@link analyzedCountFitsFound}). A store that has outlived
 * its transcripts holds more rows than the disk has files, and "2,443 / 940" on
 * an unlabelled counter is those two populations collapsed into one quotient
 * reading 260% of itself (ISS-10582).
 *
 * Both or neither, because the banner's own counter already refuses half a pair.
 * Checked over the SOURCES rather than the two totals: the fit is per harness,
 * and one row's overshoot hides inside a sibling's headroom once summed. The
 * per-source rows still state both counts — each one there carries its own
 * label, so nothing invites the reader to divide them.
 */
function counterPair(measured: MeasuredDiscovery | null): {
  analyzed: number | null;
  found: number | null;
} {
  if (measured === null) {
    return { analyzed: null, found: null };
  }
  const fits = measured.sources.every(
    (source) =>
      source.detection.status !== "detected" ||
      source.detection.analyzed === null ||
      analyzedCountFitsFound(source.detection.analyzed, source.detection.found)
  );
  if (!fits) {
    return { analyzed: null, found: null };
  }
  return {
    analyzed: measured.sessionsAnalyzed,
    found: measured.sessionsFound,
  };
}

type MeasuredDiscovery = Extract<
  OnboardingSessionDiscovery,
  { status: "measured" }
>;

/**
 * The bar's props for one frame, choosing between a host-measured pass and the
 * onboarding-derived inputs.
 *
 * ISS-10492 gave an `active` host pass precedence, because a startup stage is
 * what the reader is actually waiting on. ISS-10950 carved out the screen
 * where that precedence is wrong: a rule about which pass is more interesting is
 * not a licence to answer a question the reader has not been asked yet.
 *
 * Session Discovery also suppresses the host pass until Continue advances.
 * Starting analysis alone never exposes the ambient bar.
 *
 * An UNREAD run suppresses it too (ISS-11279), which is the case an absent phase
 * used to hand the override straight through. See {@link OnboardingRunStanding}
 * for why an absent phase is not one answer, and
 * {@link SUPPRESSING_RUN_STANDING} for why a run read that FAILED still shows
 * the bar.
 */
export function resolveAnalysisBannerInputs<
  TOverride extends OnboardingAnalysisBannerInputs,
>({
  discovery,
  history,
  override,
  phase,
  progress,
  runStanding = OnboardingRunStanding.Read,
  settled,
}: {
  discovery: OnboardingSessionDiscovery;
  /** Completed phases distinguish the older early-sync order from late sync. */
  history: readonly OnboardingPhase[] | undefined;
  override: TOverride | undefined;
  phase: OnboardingPhase | undefined;
  progress: OnboardingAnalysisProgress;
  /**
   * Whether the governing run has been read. Defaults to `Read`, so a caller
   * that holds a phase is unaffected; a caller with no phase owes this.
   */
  runStanding?: OnboardingRunStanding;
  settled: boolean;
}): TOverride | OnboardingAnalysisBannerInputs {
  const suppressed =
    SUPPRESSING_RUN_STANDING[runStanding] ||
    (phase !== undefined &&
      (isPreAnalysisConsentPhase(phase) ||
        phase === OnboardingPhase.SessionDiscovery ||
        (phase === OnboardingPhase.SyncPolicy &&
          !history?.includes(OnboardingPhase.SessionDiscovery))));
  if (override?.active && !suppressed) {
    return override;
  }
  const derived = deriveAnalysisBannerInputs({
    discovery,
    phase,
    progress,
    settled,
  });
  if (suppressed) {
    return { ...derived, active: false };
  }
  // ISS-11668 ruling 15 (operator, 2026-10-02): a host pass leaving the bar
  // keeps its own frame through the exit. Falling back here slid a finished
  // sync out on the parse counter ("400 / 400", full). An override that states
  // nothing never showed, so the derived pass still closes its own bar.
  if (override !== undefined && !derived.active && statesFrame(override)) {
    return override;
  }
  return derived;
}

/** Whether a host pass's frame states anything the bar can show. */
function statesFrame(inputs: OnboardingAnalysisBannerInputs): boolean {
  return (
    inputs.analyzed !== null || inputs.found !== null || inputs.percent !== null
  );
}

/**
 * Whether Session discovery has reported, with X read wherever it counted a Y,
 * so the bar's first frame can show "X / Y" (ISS-11668 ruling 16, operator,
 * 2026-10-02).
 *
 * A machine whose sessions discovery cannot count (Cursor or Copilot only) has
 * no Y, so its bar shows without a counter: a gracefully degraded experience is
 * fine there (operator ruling, 2026-10-02).
 */
export function isDiscoveryReady(
  discovery: OnboardingSessionDiscovery
): boolean {
  if (discovery.status !== "measured") {
    return false;
  }
  if (discovery.sessionsFound === null) {
    // No Y can mean the inventory has not reported yet, or that it reported
    // nothing it can count. Only the second has the inventory's own byte total.
    return discovery.logBytes !== null;
  }
  return discovery.sessionsAnalyzed !== null;
}
