import { ProgressTone } from "@closedloop-ai/design-system/components/ui/progress";
import { StartupReadinessPhase } from "./startup-readiness-state";

export const STARTUP_PROGRESS_BAR_LABEL = "Desktop startup progress";

export type StartupProgressBarModel = {
  /**
   * `null` is Radix's indeterminate contract — the rendered bar emits no
   * `aria-valuenow`, so it cannot claim a completion level it does not know.
   */
  value: number | null;
  /** Freezes the sweep so a moving bar never implies stalled work is advancing. */
  paused: boolean;
  /**
   * The stage the bar is reporting. It is folded into the accessible NAME
   * rather than left to `aria-valuetext` alone: WAI-ARIA requires
   * `aria-valuenow` alongside `aria-valuetext`, and an indeterminate bar has no
   * `aria-valuenow` to give, so assistive-tech handling of a valuetext-only
   * progressbar is unspecified. The name is the one channel that is guaranteed.
   */
  valueText: string;
  /**
   * Semantic tone handed to the shared `Progress`. It is a prop rather than a
   * `[&>[data-slot=progress-indicator]]:bg-*` child selector at the call site,
   * so the track, the determinate fill and the indeterminate hatch/sheen all
   * move together instead of the fill alone.
   */
  tone: ProgressTone;
};

const WORKING_BAR = {
  value: null,
  paused: false,
  tone: ProgressTone.Default,
} as const;

/**
 * Exhaustive by phase so a newly added startup phase fails typecheck instead of
 * silently inheriting another phase's progress claim.
 */
const PROGRESS_BAR_BY_PHASE: Record<
  StartupReadinessPhase,
  StartupProgressBarModel
> = {
  [StartupReadinessPhase.OpeningStore]: {
    ...WORKING_BAR,
    valueText: "Opening the local store",
  },
  [StartupReadinessPhase.LoadingSaved]: {
    ...WORKING_BAR,
    valueText: "Loading saved sessions",
  },
  [StartupReadinessPhase.CheckingHistory]: {
    ...WORKING_BAR,
    valueText: "Checking local history",
  },
  [StartupReadinessPhase.ProcessingHistory]: {
    ...WORKING_BAR,
    valueText: "Processing local history",
  },
  [StartupReadinessPhase.PreparingViews]: {
    ...WORKING_BAR,
    valueText: "Preparing session views",
  },
  [StartupReadinessPhase.SyncingCloud]: {
    ...WORKING_BAR,
    valueText: "Syncing cloud history",
  },
  [StartupReadinessPhase.NeedsAttention]: {
    value: null,
    paused: true,
    valueText: "Startup needs attention",
    // Warning-toned, and the primitive renders a paused indeterminate bar as a
    // static hatch: held at an unknown amount, not a full amber fill claiming
    // work that is not advancing.
    tone: ProgressTone.Warning,
  },
  [StartupReadinessPhase.Ready]: {
    value: 100,
    paused: false,
    valueText: "Startup complete",
    tone: ProgressTone.Success,
  },
  // The panel unmounts in this phase, so the bar is never shown. It still needs
  // an honest entry rather than a borrowed one.
  [StartupReadinessPhase.Hidden]: {
    ...WORKING_BAR,
    valueText: "Startup status unavailable",
  },
};

/** The only phases whose work the Pause control can actually stop. */
const PAUSABLE_PHASES: ReadonlySet<StartupReadinessPhase> = new Set([
  StartupReadinessPhase.CheckingHistory,
  StartupReadinessPhase.ProcessingHistory,
]);

const PAUSED_BAR_STAGE_TEXT = "History processing is paused";

/**
 * ISS-5115: derives the single global startup progress bar that replaces the
 * redundant top loading ring.
 *
 * Startup has no true overall percentage. `sourceFileProgress` is a real ratio,
 * but it measures ONE of three stages and the stages are not equal-length, so
 * promoting it to an overall figure would be a fabricated number. The bar is
 * therefore indeterminate for every in-flight phase and determinate only at
 * Ready, where 100 is a fact. The honest source-file numbers keep their own
 * labelled bar inside the expanded checklist.
 */
export function buildStartupProgressBarModel({
  phase,
  paused,
}: {
  phase: StartupReadinessPhase;
  paused: boolean;
}): StartupProgressBarModel {
  const base = PROGRESS_BAR_BY_PHASE[phase];
  if (!(paused && isPausablePhase(phase))) {
    return base;
  }
  return {
    ...base,
    paused: true,
    valueText: PAUSED_BAR_STAGE_TEXT,
  };
}

/**
 * The phases whose work the Pause control can actually stop. `canPause` in the
 * panel body reads this too, so the button cannot appear over a bar that keeps
 * sweeping, or vanish from one that has frozen.
 */
export function isPausablePhase(phase: StartupReadinessPhase): boolean {
  return PAUSABLE_PHASES.has(phase);
}

export function startupProgressBarName(valueText: string): string {
  return `${STARTUP_PROGRESS_BAR_LABEL}: ${valueText}`;
}
