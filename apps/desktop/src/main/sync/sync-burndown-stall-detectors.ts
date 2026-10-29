/**
 * @file sync-burndown-stall-detectors.ts
 * @description ISS-9823 — the burn-down's stall WATCH: the per-lane
 * bookkeeping every stall condition needs, and the four condition handlers
 * that use it.
 *
 * ## Why it is not in the reporter
 *
 * `sync-burndown-reporter.ts` grew one hand-rolled copy of the same three-part
 * shape per detector — a consecutive-sample TALLY, a per-episode LATCH, and
 * (for the conditions that do not clear themselves) a log THROTTLE — across
 * `maybeWarnCursorStall`, `maybeWarnNoProgress` and `maybeWarnGatedBacklog`.
 * Three copies is where the pattern is still legible; a fourth is where the
 * differences between them stop being deliberate and start being accidents.
 * The reporter also carries no grandfather entry, so it had no room for one:
 * adding this condition in place put it over the 1,000-line ceiling.
 *
 * Sampling, snapshot construction, and the fully-synced verdict stay in the
 * reporter. This owns one question — given a lane's row and its predecessor,
 * does anything need warning about — and holds the state that answers it
 * across samples.
 *
 * ## The two rules the copies genuinely shared
 *
 *  - **The tally and the detector must agree on what a qualifying sample is.**
 *    ISS-8142: a tally that advances through samples the detector does not
 *    count arrives at the threshold already satisfied and pages on the first
 *    sample that does count. `maybeWarnNoProgress` does not hold to this — see
 *    its own note for the pre-existing divergence it carries.
 *  - **The tally and the episode latch re-arm SEPARATELY.** A sample that is
 *    merely exempt or unmeasurable is not evidence the condition cleared, so it
 *    re-arms the tally ({@link LaneStallEpisodes.rearmTally}) and deliberately
 *    leaves the latch alone — clearing both would re-page an unbroken outage.
 *    Only an actual recovery re-arms the whole episode
 *    ({@link LaneStallEpisodes.rearm}).
 *
 * No timers, no I/O, no store access. WHAT counts as a qualifying sample stays
 * with each detector in `shared/sync-burndown-contract.ts`; this owns the
 * counting, the throttling, and the emission.
 */

import {
  CursorStallVerdict,
  classifyCursorStall,
  detectGatedBacklogStall,
  detectNoProgressStall,
  detectResumeBlockedStall,
  formatCursorStallLine,
  formatGatedBacklogStallLine,
  formatNoProgressStallLine,
  formatResumeBlockedStallLine,
  GATE_SHUT_STALL_SAMPLES,
  laneIsNotDelivering,
  laneResumeReadIsBlocked,
  NO_PROGRESS_STALL_SAMPLES,
  type SyncLaneBurndown,
  type SyncLaneDeadLetteredBasis,
  SyncLaneDrainState,
  type SyncLaneId,
  SyncLaneStallKind,
  ZERO_WORK_EXEMPTION_RE_ARMS_TALLY,
  zeroWorkExemptionFor,
} from "../../shared/sync-burndown-contract.js";

/**
 * ISS-8768 (marisolashgrove review, operator decision): how often a SELF-SUSTAINING
 * stall's WARN log re-prints once its episode is already reported.
 *
 * Two conditions need it, for the same reason. `NeverStarted` is PERMANENT for
 * an unpaired machine, and a failing durable read keeps failing (ISS-9823) —
 * unlike {@link SyncLaneStallWatcher.maybeWarnNoProgress}'s stall, which
 * requires `Draining` and so stops logging on its own the moment the lane
 * either recovers or leaves that state, neither of these leaves its condition
 * without outside intervention. Left unthrottled either is a `gatewayLog.warn`
 * every sample, forever. The monitored alert already dedupes per episode on its
 * own latch and is untouched by this — this bounds only the local log line's
 * cadence, expressed in wall-clock time (not a sample count) so it stays
 * correct if the sample interval is ever reconfigured.
 */
const PERSISTENT_STALL_LOG_THROTTLE_MS = 60 * 60 * 1000;

/** What a detected stall reports to the monitored sink. */
export type SyncLaneStallReport = {
  lane: SyncLaneId;
  workCompletedSincePrevious: number;
  durableCursorAgeMs: number | null;
  deadLetteredCount: number;
  /**
   * ISS-9744: what {@link deadLetteredCount} counted. OPTIONAL for the same
   * version-skew reason as {@link kind} — a sink built against the pre-ISS-9744
   * shape keeps compiling — and ABSENT is "basis unknown", never a default,
   * because guessing one is the collapse this field exists to close.
   */
  deadLetteredBasis?: SyncLaneDeadLetteredBasis;
  /**
   * ISS-5973: WHY the stall was raised. OPTIONAL so a sink built against the
   * pre-ISS-5973 shape keeps compiling and keeps working; a consumer that does
   * not recognise the value must fall back to the cursor-frozen wording rather
   * than drop the alert.
   */
  kind?: SyncLaneStallKind;
  /**
   * ISS-5973: items the lane still owed when the stall was raised, where the
   * lane counts a queue. `null` when the lane has no per-item queue or the count
   * was unmeasurable — never a fabricated 0.
   */
  itemsRemaining?: number | null;
  /**
   * ISS-5973: true when {@link itemsRemaining} is a FLOOR, because the lane's
   * probe is bounded and hit its cap. Carried into the alert so a 3,500-session
   * backlog cannot be reported as an exact, reassuring `200`. OPTIONAL and
   * defaulting to exact, for the same version-skew reason as {@link kind}.
   */
  itemsRemainingIsLowerBound?: boolean;
  /**
   * ISS-7401: rows the lane REPORTED clearing since the previous sample, or
   * `null` when it keeps no such counter. Carried so triage can tell a lane
   * delivering under a refill from a genuinely frozen one. A stall that reaches
   * this report has a count the detector did NOT accept as progress (ISS-10429)
   * — see {@link SyncLaneBurndown.queueRowsClearedSincePrevious}.
   */
  queueRowsClearedSincePrevious?: number | null;
};

/**
 * One stall condition's per-lane state: how many consecutive samples have held
 * it, and whether the monitored alert has already fired for this episode.
 *
 * Bounded by the lane set on both halves — keys are only ever
 * {@link SyncLaneId} values — so neither can grow without bound.
 */
export class LaneStallEpisodes {
  private readonly consecutiveSamples = new Map<SyncLaneId, number>();
  private readonly reportedLanes = new Set<SyncLaneId>();

  /** Count one qualifying sample and answer the new consecutive run length. */
  countSample(lane: SyncLaneId): number {
    const next = (this.consecutiveSamples.get(lane) ?? 0) + 1;
    this.consecutiveSamples.set(lane, next);
    return next;
  }

  /**
   * Re-arm the TALLY only, leaving the episode latch standing.
   *
   * For a sample that is EXEMPT or UNMEASURABLE rather than recovered: the
   * condition may well still hold, so an unbroken outage must need a fresh run
   * of qualifying samples before the threshold is reached again, WITHOUT the
   * already-reported episode being allowed to page a second time.
   */
  rearmTally(lane: SyncLaneId): void {
    this.consecutiveSamples.delete(lane);
  }

  /**
   * Re-arm the whole episode — tally and latch. For an actual RECOVERY only, so
   * a condition that recurs afterwards is reported as the new episode it is.
   */
  rearm(lane: SyncLaneId): void {
    this.consecutiveSamples.delete(lane);
    this.reportedLanes.delete(lane);
  }

  /**
   * Claim the right to raise the monitored alert for this lane, answering
   * `true` exactly once per episode.
   *
   * The claim and the mark are one call deliberately: as two statements (`has`
   * then `add`) they are two a caller can reorder or forget to pair, which is
   * how a detector ends up paging every sample.
   */
  claimEpisode(lane: SyncLaneId): boolean {
    if (this.reportedLanes.has(lane)) {
      return false;
    }
    this.reportedLanes.add(lane);
    return true;
  }

  /** Forget every lane. For a lifecycle or identity boundary. */
  clear(): void {
    this.consecutiveSamples.clear();
    this.reportedLanes.clear();
  }
}

/**
 * Should THIS sample print a self-sustaining stall's recurring WARN log?
 *
 * The first occurrence always prints (the operator needs to see the moment the
 * threshold crossed), then it backs off to once per `throttleMs`, converted to
 * samples from the configured interval so the cadence stays correct if the
 * sample interval is ever reconfigured. `consecutiveSamples` is 1-indexed from
 * the first qualifying sample, so subtracting `thresholdSamples` aligns sample
 * 0 of the throttle window with the first logged sample.
 */
export function shouldLogThrottledStallSample(input: {
  consecutiveSamples: number;
  thresholdSamples: number;
  intervalMs: number;
  throttleMs: number;
}): boolean {
  if (input.consecutiveSamples === input.thresholdSamples) {
    return true;
  }
  const samplesPerThrottleWindow = Math.max(
    1,
    Math.round(input.throttleMs / input.intervalMs)
  );
  return (
    (input.consecutiveSamples - input.thresholdSamples) %
      samplesPerThrottleWindow ===
    0
  );
}

export type SyncLaneStallWatcherOptions = {
  /**
   * The reporter's WARN sink. Narrowed to warn deliberately: every line this
   * module emits is one, and taking the reporter's level enum would make this
   * module able to emit an `info` the burn-down's emission policy governs.
   */
  warn: (message: string) => void;
  /**
   * The monitored sink. A raw log is not an alert, so a detected stall routes
   * to the caller's existing monitored transport rather than one invented here.
   */
  onLaneStall?: (report: SyncLaneStallReport) => void;
  /**
   * ISS-8768: does this machine's persisted consent say THIS LANE should be
   * delivering? Per-lane, because the lanes do not share one consent axis — see
   * {@link detectGatedBacklogStall}.
   */
  isLaneDeliveryConsented: (lane: SyncLaneId) => boolean;
  /** The reporter's resolved sample cadence, read per sample so a reconfigure lands. */
  intervalMs: () => number;
};

/**
 * The four stall conditions the burn-down watches, and the state that spans
 * samples for each.
 *
 * They stay four handlers rather than one, because they latch independently
 * and an operator acts on them differently: a frozen cursor means uploads are
 * landing and not being recorded, a no-progress lane means a live queue is not
 * being worked, a shut gate means the machine is not delivering at all and the
 * fix is its registration or credential, and a failing resume read means a
 * durable read is broken so the queue is never reached.
 *
 * Their preconditions are NOT mutually exclusive. `resume_read_failed`
 * deliberately overlaps `no_progress` on a wedged lane that still holds rows:
 * the measured backlog is classified first, so such a lane answers `draining`
 * and both handlers qualify on the same sample. Two alerts is the intended
 * outcome there — they name different faults and send an operator to different
 * fixes — so do not fold or dedupe the handlers on the premise that only one
 * of them can fire.
 */
export class SyncLaneStallWatcher {
  private readonly options: SyncLaneStallWatcherOptions;
  /** ISS-5347: lanes completing work their durable cursor is not recording. */
  private readonly cursorStallEpisodes = new LaneStallEpisodes();
  /**
   * ISS-10429: the cursor boundary each open cursor-stall episode paged about,
   * or `null` when it was unknown. Keyed by lane, so bounded like the latch.
   */
  private readonly cursorStallBoundaryAtClaim = new Map<
    SyncLaneId,
    string | null
  >();
  /** ISS-5973: lanes `Draining` while completing zero work. */
  private readonly noProgressEpisodes = new LaneStallEpisodes();
  /** ISS-8768: lanes NOT DELIVERING while consented and owing work. */
  private readonly gatedBacklogEpisodes = new LaneStallEpisodes();
  /** ISS-9823: lanes running with a failing once-per-identity resume read. */
  private readonly resumeBlockedEpisodes = new LaneStallEpisodes();

  constructor(options: SyncLaneStallWatcherOptions) {
    this.options = options;
  }

  /** Judge one lane's sample against all four conditions. */
  observe(input: {
    previous: SyncLaneBurndown | null;
    current: SyncLaneBurndown;
  }): void {
    this.maybeWarnCursorStall(input.previous, input.current);
    this.maybeWarnNoProgress(input.previous, input.current);
    this.maybeWarnGatedBacklog(input.previous, input.current);
    this.maybeWarnResumeBlocked(input.current);
  }

  /**
   * Forget every episode. For a lifecycle boundary, or a compute-target switch
   * whose baselines the reporter is discarding — an episode counted under the
   * previous identity cannot be continued under this one.
   */
  clear(): void {
    this.cursorStallEpisodes.clear();
    this.cursorStallBoundaryAtClaim.clear();
    this.noProgressEpisodes.clear();
    this.gatedBacklogEpisodes.clear();
    this.resumeBlockedEpisodes.clear();
  }

  private maybeWarnCursorStall(
    previous: SyncLaneBurndown | null,
    lane: SyncLaneBurndown
  ): void {
    const verdict = classifyCursorStall({ previous, current: lane });
    if (
      verdict === CursorStallVerdict.SteadyDrain &&
      this.pagedCursorBoundaryStillOwed(lane)
    ) {
      // ISS-10429: exempt, but the cursor has not moved and the boundary is not
      // yet past the row the open episode paged about. That row may still be
      // owed, so the latch stays standing and a return to it does not re-page.
      this.cursorStallEpisodes.rearmTally(lane.lane);
      return;
    }
    if (verdict !== CursorStallVerdict.Stalled) {
      // The cursor moved, the lane went quiet, or the boundary moved past the
      // paged row. Re-arm, so a stall that recurs afterwards (on a different
      // row) is reported again instead of being suppressed by the previous
      // episode's latch.
      this.cursorStallEpisodes.rearm(lane.lane);
      this.cursorStallBoundaryAtClaim.delete(lane.lane);
      return;
    }
    this.options.warn(formatCursorStallLine(lane));
    if (!this.cursorStallEpisodes.claimEpisode(lane.lane)) {
      // Already reported this episode. The warn line above still goes to the
      // log every sample (it is the trend), but the monitored signal fires once
      // per episode so a multi-hour stall is one alert, not one an interval.
      return;
    }
    this.cursorStallBoundaryAtClaim.set(
      lane.lane,
      lane.cursorBoundaryValue ?? null
    );
    this.report(lane, SyncLaneStallKind.CursorFrozen, {
      workCompletedSincePrevious: lane.workCompletedSincePrevious ?? 0,
    });
  }

  /**
   * ISS-5973: the lane is running, still owes work, and is completing none of
   * it.
   *
   * Pre-existing divergence, moved here verbatim rather than changed: this
   * tally gate reads only the CURRENT sample, while {@link detectNoProgressStall}
   * additionally requires the PREVIOUS one to be `Draining`. The sample on
   * which a lane ENTERS `Draining` therefore advances the tally without
   * qualifying for the detector, so the alert can fire one sample earlier than
   * the detector's own definition implies. The two newer handlers gate their
   * tally on a single exported predicate ({@link laneIsNotDelivering},
   * {@link laneResumeReadIsBlocked}) precisely to close that gap; that is the
   * pattern to copy, not this one.
   */
  private maybeWarnNoProgress(
    previous: SyncLaneBurndown | null,
    lane: SyncLaneBurndown
  ): void {
    const isZeroWorkSample =
      lane.state === SyncLaneDrainState.Draining &&
      (lane.workCompletedSincePrevious ?? 0) <= 0;
    if (!isZeroWorkSample) {
      // Progress, or the lane left `Draining`. Re-arm so a stall that recurs
      // after a genuine advance is reported again.
      this.noProgressEpisodes.rearm(lane.lane);
      return;
    }
    const exemption = zeroWorkExemptionFor(previous, lane);
    if (ZERO_WORK_EXEMPTION_RE_ARMS_TALLY[exemption]) {
      // ISS-8142: the whole backlog is inside its backoff window, which
      // `detectNoProgressStall` exempts — so the tally must skip it too.
      // Counting through an exempted window and only then asking the detector
      // arrives at the threshold already satisfied, and pages on the first
      // sample the exemption lifts, before the lane has had one interval in
      // which it could have delivered anything.
      //
      // Only the tally re-arms. The episode latch is deliberately left alone: a
      // backoff window is not evidence of progress, and clearing it would let
      // one unbroken stall raise a second monitored error every time the
      // backlog dipped into backoff.
      this.noProgressEpisodes.rearmTally(lane.lane);
      return;
    }
    const consecutiveZeroWorkSamples = this.noProgressEpisodes.countSample(
      lane.lane
    );
    if (
      !detectNoProgressStall({
        previous,
        current: lane,
        consecutiveZeroWorkSamples,
      })
    ) {
      return;
    }
    this.options.warn(formatNoProgressStallLine(lane));
    if (!this.noProgressEpisodes.claimEpisode(lane.lane)) {
      // Already reported this episode; the warn line above still carries the
      // trend every sample, but the monitored signal fires once.
      return;
    }
    this.report(lane, SyncLaneStallKind.NoProgress);
  }

  /**
   * ISS-8768: the machine is consented to deliver, this lane's gate is shut,
   * and work is piling up behind it.
   */
  private maybeWarnGatedBacklog(
    previous: SyncLaneBurndown | null,
    lane: SyncLaneBurndown
  ): void {
    const deliveryConsented = this.options.isLaneDeliveryConsented(lane.lane);
    if (!(deliveryConsented && laneIsNotDelivering(lane.state))) {
      // The gate opened, or consent was withdrawn. Re-arm so a gate that shuts
      // again after a genuine recovery is reported again.
      this.gatedBacklogEpisodes.rearm(lane.lane);
      return;
    }
    if (lane.itemsRemaining === null) {
      // ISS-8768 (marisolashgrove review): UNMEASURABLE this sample — e.g. the
      // component/invocation lane's remainder needs a compute target to probe
      // against and the target is flapping — not evidence the gate reopened.
      // Mirrors the no-progress exemption split: re-arm the TALLY so an
      // unbroken outage needs a fresh run of measured samples, but leave the
      // episode LATCH alone so an already-reported outage does not page again
      // the moment the next sample happens to measure something.
      this.gatedBacklogEpisodes.rearmTally(lane.lane);
      return;
    }
    if (lane.itemsRemaining <= 0) {
      // Genuinely caught up: nothing is owed, so this is not a gate shut on a
      // backlog. Clear both — a real recovery re-arms the whole episode.
      this.gatedBacklogEpisodes.rearm(lane.lane);
      return;
    }
    const consecutiveGatedSamples = this.gatedBacklogEpisodes.countSample(
      lane.lane
    );
    if (
      !detectGatedBacklogStall({
        previous,
        current: lane,
        deliveryConsented,
        consecutiveGatedSamples,
      })
    ) {
      return;
    }
    this.warnThrottled(
      consecutiveGatedSamples,
      GATE_SHUT_STALL_SAMPLES,
      formatGatedBacklogStallLine(lane)
    );
    if (!this.gatedBacklogEpisodes.claimEpisode(lane.lane)) {
      // Already reported this episode; the throttled warn line above still
      // carries the trend, but the monitored signal fires once.
      return;
    }
    this.report(lane, SyncLaneStallKind.GateShutWithBacklog);
  }

  /**
   * ISS-9823: the lane is running, its once-per-identity resume read keeps
   * failing, and every pass is therefore abandoned before it can enqueue.
   */
  private maybeWarnResumeBlocked(lane: SyncLaneBurndown): void {
    if (!laneResumeReadIsBlocked(lane)) {
      // The read landed, or the lane stopped running. Re-arm the whole episode
      // so a fault that recurs after a genuine recovery is reported again.
      this.resumeBlockedEpisodes.rearm(lane.lane);
      return;
    }
    const consecutiveResumeBlockedSamples =
      this.resumeBlockedEpisodes.countSample(lane.lane);
    if (
      !detectResumeBlockedStall({
        current: lane,
        consecutiveResumeBlockedSamples,
      })
    ) {
      return;
    }
    this.warnThrottled(
      consecutiveResumeBlockedSamples,
      NO_PROGRESS_STALL_SAMPLES,
      formatResumeBlockedStallLine(lane)
    );
    if (!this.resumeBlockedEpisodes.claimEpisode(lane.lane)) {
      // Already reported this episode; the throttled warn line above still
      // carries the trend, but the monitored signal fires once.
      return;
    }
    this.report(lane, SyncLaneStallKind.ResumeReadFailed);
  }

  /** Print a self-sustaining condition's warn line at its throttled cadence. */
  private warnThrottled(
    consecutiveSamples: number,
    thresholdSamples: number,
    message: string
  ): void {
    if (
      shouldLogThrottledStallSample({
        consecutiveSamples,
        thresholdSamples,
        intervalMs: this.options.intervalMs(),
        throttleMs: PERSISTENT_STALL_LOG_THROTTLE_MS,
      })
    ) {
      this.options.warn(message);
    }
  }

  /**
   * The monitored report every kind sends. One builder, so a field added to
   * {@link SyncLaneStallReport} cannot reach three of the four kinds — which is
   * how `deadLetteredBasis` and the lower-bound flag would each have gone
   * missing from exactly one alert.
   *
   * `workCompletedSincePrevious` defaults to `0` rather than to the lane's
   * count: three of the four conditions require zero work by construction, and
   * only {@link maybeWarnCursorStall} — whose entire signal is work happening —
   * states one.
   */
  private report(
    lane: SyncLaneBurndown,
    kind: SyncLaneStallKind,
    overrides: { workCompletedSincePrevious?: number } = {}
  ): void {
    this.options.onLaneStall?.({
      lane: lane.lane,
      workCompletedSincePrevious: overrides.workCompletedSincePrevious ?? 0,
      durableCursorAgeMs: lane.durableCursorAgeMs,
      deadLetteredCount: lane.deadLetteredCount,
      deadLetteredBasis: lane.deadLetteredBasis,
      kind,
      itemsRemaining: lane.itemsRemaining,
      itemsRemainingIsLowerBound: lane.itemsRemainingIsLowerBound,
      queueRowsClearedSincePrevious: lane.queueRowsClearedSincePrevious ?? null,
    });
  }

  /**
   * ISS-10429: is the boundary still at or before the one the open episode
   * paged about? Compared as raw strings, like the detector. An unknown value
   * on either side answers `false`: a steady-drain sample proves the boundary
   * is known and moving, so a page raised while it was unknown was about a
   * state the lane has left.
   */
  private pagedCursorBoundaryStillOwed(lane: SyncLaneBurndown): boolean {
    const paged = this.cursorStallBoundaryAtClaim.get(lane.lane);
    const current = lane.cursorBoundaryValue;
    return (
      typeof paged === "string" &&
      typeof current === "string" &&
      current <= paged
    );
  }
}
