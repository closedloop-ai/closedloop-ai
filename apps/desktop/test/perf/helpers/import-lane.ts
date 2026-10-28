/**
 * ISS-7287 — the import lane's step names, and the failure it reports when the
 * Sessions surface never renders.
 *
 * Deliberately Playwright-free, unlike its sibling `perf-run.ts`: the decision
 * below is the one part of the lane a unit test can execute against synthetic
 * inputs, and it can only stay that way while this module imports nothing.
 *
 * Why the lane needs a named failure at all. The surface wait and the app's own
 * per-session import bound are both minute-scale, so a run that died waiting for
 * a SCREEN and a run whose IMPORT stalled used to be indistinguishable from
 * outside — both were "something timed out after about two minutes". ISS-6003
 * acquired a wrong cause exactly that way: a failed measurement read as a
 * failure of the subsystem being measured. Every failure this lane raises now
 * leads with which of the two it was.
 */

/** The launch step, recorded once the Sessions surface renders. */
export const BOOT_TO_SESSIONS_STEP = "boot-to-sessions";

/** The completion step, recorded once the session count stops changing. */
export const IMPORT_COMPLETION_STEP = "import-completion";

/**
 * The subsystem that gave up, as a token carried in the failure text.
 *
 * Disjoint by construction — one reason per subsystem — so a reader, or a grep
 * over a run's output, can attribute a failed run without reading the rest of
 * the sentence or knowing which bound is which.
 */
export const PerfFailureReason = {
  /** The renderer never reached Sessions, so the import was never measured. */
  SurfaceNeverRendered: "surface-never-rendered",
  /** The session count was still moving at the app's own boot-import bound. */
  ImportNeverSettled: "import-never-settled",
  /**
   * The population went steady but the app never reported its boot import
   * terminal, so the run could not confirm the import was what finished. A
   * separate reason because blaming the import here is a guess — the same
   * observation is produced by a renderer bridge that never came up.
   */
  LifecycleNeverTerminal: "lifecycle-never-terminal",
} as const;
export type PerfFailureReason =
  (typeof PerfFailureReason)[keyof typeof PerfFailureReason];

/** What the renderer was showing instead of the Sessions surface. */
export const SurfaceWaitBlocker = {
  Unrecognized: "unrecognized",
} as const;
export type SurfaceWaitBlocker =
  (typeof SurfaceWaitBlocker)[keyof typeof SurfaceWaitBlocker];

/** What the spec read off the page once the wait had given up. */
export type SurfaceObservation = {
  /** Headings on screen, the only clue to which screen was in the way. */
  headings?: readonly string[];
};

const BLOCKER_DIAGNOSIS: Record<SurfaceWaitBlocker, string> = {
  [SurfaceWaitBlocker.Unrecognized]:
    "no screen this lane recognizes was on top; the renderer may have crashed, or mounted a takeover the lane does not know about",
};

/**
 * The failure raised when the Sessions surface never rendered.
 *
 * States the reason token, the step that was therefore never recorded, and the
 * screen that was in the way — and says outright that the import under
 * measurement is not what failed.
 */
export function surfaceWaitFailureMessage(
  observed: SurfaceObservation,
  waitedMs: number
): string {
  const blocker = SurfaceWaitBlocker.Unrecognized;
  const headings = observed.headings ?? [];
  const seen =
    headings.length > 0 ? ` Headings on screen: ${headings.join(" | ")}.` : "";
  return (
    `${PerfFailureReason.SurfaceNeverRendered}: the Sessions surface did not render within ${waitedMs}ms, ` +
    `so \`${BOOT_TO_SESSIONS_STEP}\` was never recorded and the import was never measured. ` +
    `Blocker: ${blocker} — ${BLOCKER_DIAGNOSIS[blocker]}.${seen} ` +
    "This is the harness failing to reach the app, not the import it exists to measure."
  );
}

/** What the measurement loop had observed when it gave up. */
export type ImportTimeoutReading = {
  observedMs: number;
  /** The session count had not held steady for the required run of polls. */
  countStillChanging: boolean;
  /** The app reported `complete` or `timedOut` at least once. */
  bootImportEnded: boolean;
};

/**
 * The warning emitted when the loop gave up. The run still produced a
 * measurement — the elapsed time under the timeout step — so this is a warning
 * and not a thrown failure.
 *
 * Which of the two reasons it carries is the whole point. A steady population
 * whose lifecycle never turned terminal is NOT an import that failed to settle:
 * the app arms its own bound later than this lane's launch clock, and a renderer
 * whose bridge never came up produces the identical reading. Saying "the count
 * was still changing" there would be false, and false in the direction that
 * sends the next reader at the importer.
 */
export function importNeverSettledMessage(
  reading: ImportTimeoutReading
): string {
  const stalledLifecycle = !(
    reading.countStillChanging || reading.bootImportEnded
  );
  if (stalledLifecycle) {
    return (
      `${PerfFailureReason.LifecycleNeverTerminal}: the session count held steady, but the app never reported its boot import complete or timed out within ${reading.observedMs}ms. ` +
      `Recorded as the timeout form of \`${IMPORT_COMPLETION_STEP}\` because the settle could not be confirmed — the importer is NOT established as the thing that stalled.`
    );
  }
  return (
    `${PerfFailureReason.ImportNeverSettled}: the session count was still changing after ${reading.observedMs}ms. ` +
    `Recorded as the timeout form of \`${IMPORT_COMPLETION_STEP}\`. ` +
    "The surface rendered and the store was read every poll; the import itself did not settle."
  );
}

/** What the measurement loop knew when the stable window closed. */
export type SettlementReading = {
  /** Elapsed-since-launch of the FIRST sample in the stable window. */
  stableWindowStartedAtMs: number;
  /** Elapsed-since-launch of the first OBSERVED CHANGE in the count, or null. */
  firstCountChangeAtMs: number | null;
  /** Elapsed-since-launch of the poll that observed the settle. */
  observedAtMs: number;
};

/**
 * When the import may honestly be called settled.
 *
 * The stable window's start is the answer only once the count has been seen to
 * MOVE. A window that opened on the very first reading and never reset describes
 * a store nobody had touched yet, which on a populated shape is the expected
 * steady state — the sandbox's snapshot already holds the sessions its own
 * transcripts describe, so a re-import upserts rows and leaves `COUNT(*)` flat.
 * Recording that window's start would time the import at the first poll, which
 * is the false completion ISS-7286 was filed on, arrived at a second way.
 * Without an observed change the only defensible instant is when the app's own
 * lifecycle was seen to end.
 */
export function resolveSettleAtMs(reading: SettlementReading): number {
  if (reading.firstCountChangeAtMs === null) {
    return reading.observedAtMs;
  }
  return reading.stableWindowStartedAtMs;
}
