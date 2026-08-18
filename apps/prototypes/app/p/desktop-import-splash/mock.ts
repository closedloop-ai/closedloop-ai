// Mock model for the first-launch import/load splash. Mirrors the real desktop
// runtime-status pipeline (use-ingest-progress.ts): a source scan, the staggered
// per-harness session import, the post-boot maintenance pass (history rebuild +
// artifact-link backfill), then the insights computation, before the dashboard
// is ready. All values here are simulated locally; the prototype wires no data.

export const ImportPhase = {
  Scanning: "scanning",
  Importing: "importing",
  Finishing: "finishing",
  Computing: "computing",
  Ready: "ready",
  // The import stalled and gave up (mirrors the banner's STALL_GIVE_UP_MS): some
  // sessions could not be read, but what imported is still usable.
  Failed: "failed",
} as const;

export type ImportPhase = (typeof ImportPhase)[keyof typeof ImportPhase];

// The agent harnesses whose local logs get imported, with believable session
// counts. Order is the pass order: the import fills them one at a time, so the
// splash can point at the harness being read right now.
export type ImportHarness = {
  id: string;
  label: string;
  total: number;
};

export const importHarnesses: readonly ImportHarness[] = [
  { id: "claude", label: "Claude Code", total: 1357 },
  { id: "codex", label: "Codex", total: 842 },
  { id: "cursor", label: "Cursor", total: 613 },
  { id: "copilot", label: "Copilot", total: 421 },
  { id: "gemini", label: "Gemini CLI", total: 288 },
  { id: "opencode", label: "OpenCode", total: 174 },
];

export const grandTotalSessions = importHarnesses.reduce(
  (sum, harness) => sum + harness.total,
  0
);

// The four legible steps the splash surfaces, in order. The finishing and
// computing runtime phases both roll up under "Compute insights" so the stepper
// stays a calm four beats; the active detail line names the exact sub-activity.
export const PhaseStep = {
  Scan: "scan",
  Import: "import",
  Compute: "compute",
  Ready: "ready",
} as const;

export type PhaseStep = (typeof PhaseStep)[keyof typeof PhaseStep];

export type PhaseStepMeta = {
  step: PhaseStep;
  label: string;
};

export const phaseSteps: readonly PhaseStepMeta[] = [
  { step: PhaseStep.Scan, label: "Scan local logs" },
  { step: PhaseStep.Import, label: "Import sessions" },
  { step: PhaseStep.Compute, label: "Compute insights" },
  { step: PhaseStep.Ready, label: "Ready" },
];

// The sub-steps of the Compute stage, in order — the post-boot maintenance pass
// (history rebuild, then artifact-link backfill) followed by the insights
// aggregation. Surfaced as a small checklist so Compute has its own live
// activity instead of resting on the finished import list.
export const ComputeStep = {
  Rebuild: "rebuild",
  Links: "links",
  Insights: "insights",
} as const;

export type ComputeStep = (typeof ComputeStep)[keyof typeof ComputeStep];

export type ComputeStepMeta = {
  step: ComputeStep;
  label: string;
};

export const computeSteps: readonly ComputeStepMeta[] = [
  { step: ComputeStep.Rebuild, label: "Rebuild history timeline" },
  { step: ComputeStep.Links, label: "Link sessions to branches and PRs" },
  { step: ComputeStep.Insights, label: "Compute insights" },
];

export type StepState = "done" | "active" | "pending" | "error";

export type HarnessProgress = {
  id: string;
  label: string;
  total: number;
  processed: number;
  pct: number;
  state: StepState;
};

export type ImportState = {
  phase: ImportPhase;
  activeStep: PhaseStep;
  computeStep: ComputeStep | null;
  overallPct: number;
  processed: number;
  grandTotal: number;
  failed: boolean;
  headline: string;
  detail: string;
  perHarness: readonly HarnessProgress[];
};

// Phase boundaries along the 0..100 simulation clock. Import owns the widest
// band so the per-harness counts read as the main event.
const SCAN_END = 8;
const IMPORT_END = 68;
const REBUILD_END = 76;
const LINKS_END = 84;

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

function phaseForProgress(progress: number): ImportPhase {
  if (progress < SCAN_END) {
    return ImportPhase.Scanning;
  }
  if (progress < IMPORT_END) {
    return ImportPhase.Importing;
  }
  if (progress < LINKS_END) {
    return ImportPhase.Finishing;
  }
  if (progress < 100) {
    return ImportPhase.Computing;
  }
  return ImportPhase.Ready;
}

// Fill the harnesses sequentially from a single processed count, so exactly one
// is mid-flight at a time and the rest read done or pending. On failure the
// mid-flight harness is the one that stalled, so it reads "error" instead.
function distributeHarnesses(
  processed: number,
  failed: boolean
): HarnessProgress[] {
  let remaining = processed;
  return importHarnesses.map((harness) => {
    const taken = Math.min(harness.total, Math.max(0, remaining));
    remaining -= taken;
    const pct = harness.total > 0 ? (taken / harness.total) * 100 : 0;
    let state: StepState = "pending";
    if (taken >= harness.total) {
      state = "done";
    } else if (taken > 0) {
      state = failed ? "error" : "active";
    }
    return {
      id: harness.id,
      label: harness.label,
      total: harness.total,
      processed: taken,
      pct,
      state,
    };
  });
}

function activeStepForPhase(phase: ImportPhase): PhaseStep {
  if (phase === ImportPhase.Scanning) {
    return PhaseStep.Scan;
  }
  if (phase === ImportPhase.Importing) {
    return PhaseStep.Import;
  }
  if (phase === ImportPhase.Ready) {
    return PhaseStep.Ready;
  }
  return PhaseStep.Compute;
}

// Which Compute sub-step is running, or null outside the Compute stage. Finishing
// covers the rebuild then the artifact-link backfill; Computing is the insights
// aggregation.
function computeStepForProgress(progress: number): ComputeStep | null {
  const phase = phaseForProgress(progress);
  if (phase === ImportPhase.Finishing) {
    return progress < REBUILD_END ? ComputeStep.Rebuild : ComputeStep.Links;
  }
  if (phase === ImportPhase.Computing) {
    return ComputeStep.Insights;
  }
  return null;
}

// The detail line during import names the tool being read right now rather than
// repeating the session count (which lives on the progress bar). Falls back to a
// generic phrase between staggered per-harness passes.
function importingDetail(perHarness: readonly HarnessProgress[]): string {
  const active = perHarness.find((harness) => harness.state === "active");
  return active
    ? `Reading your ${active.label} sessions`
    : "Reading your sessions";
}

// Compute's detail sets expectation; the live sub-step lives in the checklist
// below, so this line does not repeat it.
function computeDetail(): string {
  return "A one-time step while we get your dashboard ready";
}

// How many sessions read as imported at this point in the clock: nothing during
// the scan, a growing slice during import, and the full set once import is done
// (the later phases operate on the complete history).
function processedForProgress(phase: ImportPhase, progress: number): number {
  if (phase === ImportPhase.Scanning) {
    return 0;
  }
  if (phase === ImportPhase.Importing) {
    const fraction = clamp01((progress - SCAN_END) / (IMPORT_END - SCAN_END));
    return Math.round(fraction * grandTotalSessions);
  }
  return grandTotalSessions;
}

/**
 * Derive the whole splash view state from the simulation clock plus a `failed`
 * flag. Pure and React-free so the phase math stays legible; the page component
 * just advances the clock and renders whatever this returns. When `failed`, the
 * run stopped mid-import: the Import step reads as errored and the processed
 * count is frozen where the stall hit.
 */
export function deriveImportState(
  progress: number,
  failed: boolean
): ImportState {
  const overallPct = Math.min(100, Math.max(0, progress));
  if (failed) {
    const processed = processedForProgress(ImportPhase.Importing, progress);
    return {
      phase: ImportPhase.Failed,
      activeStep: PhaseStep.Import,
      computeStep: null,
      overallPct,
      processed,
      grandTotal: grandTotalSessions,
      failed: true,
      headline: "Import didn't finish",
      detail: `Stopped after ${processed.toLocaleString()} of ${grandTotalSessions.toLocaleString()} sessions`,
      perHarness: distributeHarnesses(processed, true),
    };
  }

  const phase = phaseForProgress(progress);
  const processed = processedForProgress(phase, progress);
  const perHarness = distributeHarnesses(processed, false);
  const detail =
    phase === ImportPhase.Importing
      ? importingDetail(perHarness)
      : detailForPhase(phase);
  return {
    phase,
    activeStep: activeStepForPhase(phase),
    computeStep: computeStepForProgress(progress),
    overallPct,
    processed,
    grandTotal: grandTotalSessions,
    failed: false,
    headline: headlineForPhase(phase),
    detail,
    perHarness,
  };
}

function headlineForPhase(phase: ImportPhase): string {
  switch (phase) {
    case ImportPhase.Scanning:
      return "Scanning your local logs";
    case ImportPhase.Importing:
      return "Importing your agent history";
    case ImportPhase.Finishing:
    case ImportPhase.Computing:
      return "Computing your insights";
    default:
      return "You are all set";
  }
}

// Detail line for every phase except Importing (which names the active tool via
// `importingDetail`, since it needs the per-harness breakdown).
function detailForPhase(phase: ImportPhase): string {
  if (phase === ImportPhase.Scanning) {
    return "Looking for Claude Code, Codex, Cursor, and other agent runs on this Mac";
  }
  if (phase === ImportPhase.Ready) {
    return "Opening your dashboard";
  }
  return computeDetail();
}

// --- Simulation timeline (prototype only) -----------------------------------
// One monotonic tick drives two alternating cycles so both the happy path and a
// mid-import stall/failure play hands-off without any controls. Kept pure here;
// the hook is just an interval plus a counter.
export const TICK_MS = 60;
const STEP = 0.5; // progress units advanced per tick

const SUCCESS_RAMP = 200; // ticks to ramp 0 -> 100
const READY_HOLD = 55; // dwell on the Ready state
const FAIL_AT = 42; // a failure run stalls at this progress
const FAIL_RAMP = Math.round(FAIL_AT / STEP); // ticks to reach FAIL_AT
const STALL_HOLD = 26; // frozen bar, still "importing", before it gives up
const FAILED_HOLD = 70; // dwell on the failed state
const CYCLE_TICKS =
  SUCCESS_RAMP + READY_HOLD + FAIL_RAMP + STALL_HOLD + FAILED_HOLD;

export type SimFrame = { progress: number; failed: boolean };

/** Map a monotonic tick to the current progress and failed flag. */
export function simulate(tick: number): SimFrame {
  const t = ((tick % CYCLE_TICKS) + CYCLE_TICKS) % CYCLE_TICKS;
  if (t < SUCCESS_RAMP) {
    return { progress: Math.min(100, t * STEP), failed: false };
  }
  if (t < SUCCESS_RAMP + READY_HOLD) {
    return { progress: 100, failed: false };
  }
  const f = t - SUCCESS_RAMP - READY_HOLD;
  if (f < FAIL_RAMP) {
    return { progress: Math.min(FAIL_AT, f * STEP), failed: false };
  }
  // Hold the bar frozen at FAIL_AT (still "importing") so the stall is felt,
  // then flip to the failed treatment.
  if (f < FAIL_RAMP + STALL_HOLD) {
    return { progress: FAIL_AT, failed: false };
  }
  return { progress: FAIL_AT, failed: true };
}
