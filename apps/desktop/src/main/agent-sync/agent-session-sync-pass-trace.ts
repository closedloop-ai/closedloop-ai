/**
 * @file agent-session-sync-pass-trace.ts
 * @description Goal stage 3 (event-driven pump): the pass-lifecycle trace for
 * the session sync lane, extracted as a sibling so the grandfathered
 * `agent-session-sync-service.ts` does not grow.
 *
 * ISS-5993 observed a 60-100x tick starvation on a real machine — the 5s
 * cadence delivering one pass every 5-8 MINUTES while a pass that did run took
 * ~9s — with the gating stage unidentified. This trace exists to NAME that
 * gate from a single log line per pass, by timestamping the four stages every
 * pass moves through:
 *
 *   fired    — a trigger asked for a pass (work arrival, ack follow-up,
 *              refresh, or the fallback poll tick);
 *   admitted — `syncSessionsOnce` passed the single-flight + shouldRun gates
 *              and created the run (a large fired→admitted gap = the pump
 *              never delivered the trigger, or a previous pass held the
 *              single-flight guard);
 *   started  — the pass finished `waitForBackgroundSlot` and resolved a live
 *              source, and is about to do DB work (a large admitted→started
 *              gap = the renderer background-slot deferral or a missing
 *              source);
 *   completed — the pass's finally ran (started→completed = the real work:
 *              cursor reads, hydration, prep, send, ack processing).
 *
 * Emitted through the existing gatewayLog path (main-process file logging —
 * no client/renderer logging), one line per completed pass.
 */

/** Why a pass was asked for. The trace line carries the FIRST cause observed. */
export const SyncPassTrigger = {
  /** New local session data landed (collector import emit / live inject). */
  WorkArrival: "work-arrival",
  /** The 5s fallback sweep tick. */
  Poll: "poll",
  /** An external `refresh()` nudge (auth/org-policy/readiness change). */
  Refresh: "refresh",
  /** A productive batch self-continued the drain. */
  AckContinue: "ack-continue",
} as const;
export type SyncPassTrigger =
  (typeof SyncPassTrigger)[keyof typeof SyncPassTrigger];

/** Coarse outcome for the trace line. */
export const SyncPassOutcome = {
  /** A batch reached `sendBatch`. */
  Sent: "sent",
  /** The pass ran to completion without anything to send. */
  Idle: "idle",
  /** The pass returned early (no source, stale generation, capability defer). */
  Abandoned: "abandoned",
  /** The pass threw (logged separately by the tick-failure log). */
  Failed: "failed",
} as const;
export type SyncPassOutcome =
  (typeof SyncPassOutcome)[keyof typeof SyncPassOutcome];

export type SyncPassTraceSample = {
  trigger: SyncPassTrigger;
  firedAtMs: number;
  admittedAtMs: number;
  startedAtMs: number | null;
  completedAtMs: number;
  outcome: SyncPassOutcome;
};

/**
 * Any stage gap at or above this is worth an INFO line even for an idle pass —
 * it is exactly the starvation signature ISS-5993 is hunting. Below it, idle
 * passes log at debug so a healthy 5s cadence does not write ~17k lines/day.
 */
export const SYNC_PASS_TRACE_SLOW_GAP_MS = 10_000;

/** Render the one-line trace. Values are deltas so the line reads as a path. */
export function formatSyncPassTrace(sample: SyncPassTraceSample): string {
  const admittedGap = Math.max(0, sample.admittedAtMs - sample.firedAtMs);
  const startedGap =
    sample.startedAtMs === null
      ? null
      : Math.max(0, sample.startedAtMs - sample.admittedAtMs);
  const completedGap = Math.max(
    0,
    sample.completedAtMs - (sample.startedAtMs ?? sample.admittedAtMs)
  );
  const startedPart =
    startedGap === null
      ? "admitted→started=n/a"
      : `admitted→started=${startedGap}ms`;
  return (
    `pass trace: trigger=${sample.trigger} fired→admitted=${admittedGap}ms ` +
    `${startedPart} started→completed=${completedGap}ms outcome=${sample.outcome}`
  );
}

/** Whether the sample crosses the slow-gap threshold anywhere. */
export function isSlowSyncPass(sample: SyncPassTraceSample): boolean {
  return sample.completedAtMs - sample.firedAtMs >= SYNC_PASS_TRACE_SLOW_GAP_MS;
}
