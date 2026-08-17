// ISS-5258: pure view-state for the COLLAPSED first-launch import splash.
//
// The expanded splash says "Runs in the background" while occupying most of the
// viewport above the Sessions content — the copy and the layout contradict each
// other. Collapsing resolves that, but collapsing must cost the user detail, not
// truth: a paused import still has to read as paused, a failed one as failed,
// and a phase with no measurable progress must render nothing rather than a
// fabricated 0%.
//
// Everything here is derived from the SAME `ImportSplashState` the expanded body
// renders, and the headline is taken verbatim from it rather than re-switched
// here, so the two forms cannot drift into telling different stories about the
// same import.

import { ImportPhase, type ImportSplashState } from "./import-splash-state";

// How the collapsed row should read at a glance. Maps onto the phase/paused/
// failed matrix the expanded splash already distinguishes.
export const CompactTone = {
  /** Work is advancing (scan, import, compute). */
  Progress: "progress",
  /** The user paused the import; nothing is advancing and the row says so. */
  Paused: "paused",
  /** The import stopped without finishing. Bad news survives collapsing. */
  Attention: "attention",
  /** The import finished. */
  Done: "done",
} as const;

export type CompactTone = (typeof CompactTone)[keyof typeof CompactTone];

export type ImportSplashCompactState = {
  tone: CompactTone;
  /**
   * The expanded splash's headline, verbatim — "Import paused", "Import didn't
   * finish", "Importing your agent history". Taking it rather than re-deriving
   * it is what keeps the collapsed form honest for free: every state the
   * expanded headline distinguishes, the collapsed row distinguishes too.
   */
  label: string;
  /**
   * The count line, or `null` when no count is known yet (the scan phase has no
   * total). Never a fabricated "0 / 0 · 0%".
   */
  metrics: string | null;
  /**
   * Whether the count carries the foreground weight rather than the muted one.
   * True exactly while Importing, mirroring the expanded body, which promotes
   * the same number in the same phase: it is the reason someone collapses the
   * splash rather than dismissing it, so the collapsed form must not demote it.
   */
  promoteMetrics: boolean;
  /**
   * Whether the compact rail renders at all. Mirrors the expanded body, which
   * drops the rail entirely in the failed state rather than leaving a stalled
   * bar reading as progress.
   */
  showRail: boolean;
  /**
   * The rail value, or `null` for "amount unknown" — the `Progress` primitive's
   * indeterminate contract.
   *
   * The expanded body can afford a determinate 0 during Scan and a determinate
   * 100 during Compute because a stepper, skeleton rows and the compute
   * checklist sit under the bar and supply the context. Collapsed, the bar is
   * one of two signals, and an empty track reads "0% done" while a full one
   * reads "finished" — neither of which is what those phases mean. So the
   * collapsed rail declines to claim a position it does not have.
   */
  railPct: number | null;
  /** Pause/Resume is offered exactly where the expanded body offers it. */
  showPause: boolean;
  paused: boolean;
  /**
   * Whether the collapsed row offers the way out of the failed state. The
   * expanded body pairs its failure Alert with "Continue to dashboard";
   * collapsing must not strip the remedy and leave a red row the user cannot
   * dismiss without expanding it first.
   */
  showContinue: boolean;
};

/**
 * Derive the collapsed row from the splash state the expanded body renders.
 */
export function deriveImportSplashCompactState(
  state: ImportSplashState
): ImportSplashCompactState {
  return {
    tone: toneForState(state),
    label: state.headline,
    metrics: metricsForState(state),
    promoteMetrics: state.phase === ImportPhase.Importing,
    showRail: state.phase !== ImportPhase.Failed,
    railPct: railPctForState(state),
    showPause: state.phase === ImportPhase.Importing,
    paused: state.paused,
    showContinue: state.phase === ImportPhase.Failed,
  };
}

function toneForState(state: ImportSplashState): CompactTone {
  if (state.phase === ImportPhase.Failed) {
    return CompactTone.Attention;
  }
  if (state.paused && state.phase === ImportPhase.Importing) {
    return CompactTone.Paused;
  }
  if (state.phase === ImportPhase.Ready) {
    return CompactTone.Done;
  }
  return CompactTone.Progress;
}

/**
 * The count line per phase.
 *
 * - Scanning has no total yet, so it claims nothing.
 * - Import (running or paused) carries the honest "N / M transcripts". NO
 *   percentage: the rail directly beneath is filled to exactly that percentage,
 *   so printing it too says the same thing twice in the one place where
 *   horizontal room is the whole constraint. Dropping it also buys the sentence
 *   room before anything truncates, because the narrowing strategy in
 *   `import-splash-compact.tsx` squeezes this number before the label.
 * - Failed carries the same counts; there is no rail there to carry a position,
 *   but a percentage beside a stopped import would read as progress that is
 *   still happening, so it stays absent for that reason instead.
 * - Compute and Ready state what was actually imported — `processed`, not
 *   `total`: a complete payload can still have skipped sources, and claiming
 *   the denominator would over-report. The import really is finished at that
 *   point, but the remaining rebuild work has no percentage of its own, so the
 *   row reports the count rather than implying a global "100% done".
 *
 * ISS-5281: the noun is TRANSCRIPTS, matching the expanded body. This pair is
 * source-file units — one OpenCode source is a whole `opencode.db` holding many
 * sessions — so calling it "sessions" undercounts against the Sessions list by
 * an unknown amount, and would make the collapsed row disagree with the
 * expanded panel it collapses from.
 */
function metricsForState(state: ImportSplashState): string | null {
  // The no-total guard sits ABOVE every phase branch: an import that stalls
  // during the scan is Failed with a zero total, and "0 / 0 transcripts" would be
  // exactly the fabricated count this module promises never to print.
  if (state.total <= 0) {
    return null;
  }
  const processed = state.processed.toLocaleString();
  const total = state.total.toLocaleString();
  if (
    state.phase === ImportPhase.Failed ||
    state.phase === ImportPhase.Importing
  ) {
    return `${processed} / ${total} transcripts`;
  }
  return `${processed} transcripts imported`;
}

/**
 * The rail value, or `null` for the indeterminate treatment.
 *
 * Import and Ready have a real measured position. Scan has not found a total
 * yet, and Compute's remaining rebuild is unmeasured — a determinate 0 and a
 * determinate 100 would read as "nothing done" and "all done" respectively, and
 * both are wrong.
 */
function railPctForState(state: ImportSplashState): number | null {
  if (
    state.phase === ImportPhase.Importing ||
    state.phase === ImportPhase.Ready
  ) {
    return state.overallPct;
  }
  return null;
}
