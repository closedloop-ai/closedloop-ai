// Pure view-state for the first-launch import splash. React-free so the phase
// math stays legible and unit-testable in isolation; the splash component just
// feeds it the polled ingest + maintenance signals and renders what it returns.
//
// This mirrors the agreed prototype (apps/prototypes/app/p/desktop-import-splash)
// but is driven by the REAL runtime-status pipeline instead of a simulated clock:
// per-harness rows come from `ingest.byHarness`, the Compute sub-steps come from
// the honest maintenance `phase`, and the failed state is the banner's stall
// give-up surfaced as a graceful partial-import outcome rather than a silent
// collapse.

import { MaintenancePhase } from "../../../shared/maintenance-progress-contract";
import type {
  HarnessIngest,
  IngestProgress,
  MaintenanceProgress,
} from "../../hooks/use-ingest-progress";
import {
  describeImportProgress,
  describeQuarantinedSources,
  formatCount,
  resolveCouldNotImportCount,
  resolveQuarantinedStageCounts,
} from "../import-progress-display";
import {
  deriveSyncFootnoteState,
  type SyncFootnoteState,
  type TranscriptSyncStatusRead,
} from "./sync-footnote-state";

// The four legible phases the stepper surfaces, in order. The runtime's
// scan/import phases map 1:1; the post-boot maintenance pass (history rebuild +
// artifact-link backfill) rolls up under Compute so the stepper stays a calm
// four beats.
export const ImportPhase = {
  Scanning: "scanning",
  Importing: "importing",
  Computing: "computing",
  Ready: "ready",
  // The import stalled and gave up (the banner's STALL_GIVE_UP_MS): some sessions
  // could not be read, but what imported is still usable.
  Failed: "failed",
} as const;

export type ImportPhase = (typeof ImportPhase)[keyof typeof ImportPhase];

// Short stepper labels. The prototype's long labels ("Scan local logs", …)
// truncate at 1440 wide (FEA-4057), so ship the legible short forms.
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
  { step: PhaseStep.Scan, label: "Scan" },
  { step: PhaseStep.Import, label: "Import" },
  { step: PhaseStep.Compute, label: "Compute" },
  { step: PhaseStep.Ready, label: "Ready" },
];

// The Compute sub-steps, in order. These map directly onto the main process's
// reported maintenance `phase` — no invented activity: Rebuild = the
// data-revision history rebuild, Links = the artifact-link backfill.
export const ComputeStep = {
  Rebuild: "rebuild",
  Links: "links",
} as const;

export type ComputeStep = (typeof ComputeStep)[keyof typeof ComputeStep];

export type ComputeStepMeta = {
  step: ComputeStep;
  label: string;
};

export const computeSteps: readonly ComputeStepMeta[] = [
  { step: ComputeStep.Rebuild, label: "Rebuild history timeline" },
  { step: ComputeStep.Links, label: "Link sessions to branches and PRs" },
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

/**
 * ISS-6241: how far the live Compute sub-step has drained its own population.
 *
 * `null` is the DEFAULT and an honest state, not a failure: only the rebuild can
 * substantiate a total, and only once its stale-session query has returned. The
 * artifact-link backfill runs inside the db host behind a single awaited op with
 * no progress channel out, so it has no numbers to report and must never borrow
 * the rebuild's. Renderers show an indeterminate step for `null` — never a
 * synthesized `0 of 0`, which is the shape ISS-5932 exists to prevent.
 *
 * Deliberately NOT a percentage. A ratio invites the monotonic-latch problem
 * FEA-4156 fixed for the import rail, and this population legitimately SHRINKS
 * between attempts (the rebuild is cursored on the revision stamp, so a
 * re-driven attempt re-selects a smaller stale set). Two honest counts that can
 * both move are safer than one derived number that must not go backwards.
 */
export type ComputeProgress = {
  processed: number;
  total: number;
};

export type ImportSplashState = {
  phase: ImportPhase;
  activeStep: PhaseStep;
  computeStep: ComputeStep | null;
  /** ISS-6241: `null` unless the live compute step reports a real population. */
  computeProgress: ComputeProgress | null;
  overallPct: number;
  processed: number;
  total: number;
  paused: boolean;
  failed: boolean;
  inMaintenancePhase: boolean;
  /**
   * ISS-6241 (review): whether a maintenance pass is LIVE right now, read
   * straight off the payload's authoritative `active` bit.
   *
   * {@link computeStep} cannot answer that on its own, because `null` there is
   * TWO different facts: the pass wound down, OR a live pass named a phase this
   * build has no sub-step for. The boundary validator degrades an unrecognised
   * phase to `null` while preserving `active` — the version-skew degrade
   * `maintenance-progress-contract.ts` spells out — so reading the null alone as
   * "finished" green-checks every Compute sub-step through a running pass.
   *
   * NOT the same as {@link inMaintenancePhase}, which the banner LATCHES once it
   * has seen a pass so the splash cannot flicker; that stays true through the
   * wind-down tail. The sibling readiness panel gates on this same `active` bit
   * (`startup-readiness-state.ts`'s `getPhase`).
   */
  maintenanceActive: boolean;
  headline: string;
  detail: string;
  /**
   * ISS-5281 (review): the failed state's alert copy, derived HERE beside the
   * headline and detail so exactly one call to {@link describeImportShortfall}
   * owns the whole message. The body used to re-run that helper to get these two
   * strings, which is the seam this ticket set out to close. `null` on every
   * non-failed phase, and on a failed branch whose alert has no fact the detail
   * line above it has not already carried.
   */
  alertTitle: string | null;
  /** The failed state's way-forward sentence; `null` on every other phase. */
  alertDetail: string | null;
  perHarness: readonly HarnessProgress[];
  /**
   * ISS-5281: how many SOURCE TRANSCRIPTS were quarantined and are no longer
   * retried. A population distinct from the transcript counts above. 0 on a
   * clean run.
   *
   * ISS-6115 (wongk review): renamed off `couldNotReadCount`. The store is now
   * charged by the IMPORT bound too, and on that path the transcript was read
   * fine — it is the write that did not finish — so "read" was no longer what
   * the number measured. The phrase the UI may actually use for it is
   * {@link ImportSplashState.couldNotImportLabel}, which is stage-aware; this
   * stays the numeric gate.
   */
  couldNotImportCount: number;
  /**
   * ISS-6115: the stage-accurate phrase for {@link couldNotImportCount}, or
   * `null` when nothing was quarantined. Derived here rather than in the body so
   * one fact keeps one phrasing across every surface that reports it.
   */
  couldNotImportLabel: string | null;
  /**
   * ISS-4716: the footer's transcript-sync line. ISS-5348 made this
   * non-nullable — `null` used to mean "the retired Labs flag is off, so render
   * the previous hardcoded node", and that node is gone.
   */
  syncFootnote: SyncFootnoteState;
};

// Signals that drive the splash, gathered by the component from its hooks + the
// banner's derived lifecycle flags so the pure derivation stays React-free.
export type ImportSplashInput = {
  ingest: IngestProgress | null;
  processed: number;
  total: number;
  paused: boolean;
  // The banner already computes these lifecycle flags (settled/maintenance/…);
  // pass them in rather than re-deriving so the two never drift.
  inMaintenancePhase: boolean;
  // Every harness's boot import has finished. With no maintenance following, this
  // is the brief Ready celebration held before the splash collapses.
  complete: boolean;
  maintenance: MaintenanceProgress | null;
  // The stall give-up fired: the import stopped without completing.
  failed: boolean;
  // FEA-4156: the highest overall percentage shown so far this launch. Harnesses
  // register their session totals as each source scan finishes and are summed
  // into the aggregate, so a late-registering harness makes the denominator jump
  // and the raw ratio step backwards. A rail that retreats reads as broken, so
  // the component latches the running max and passes it here; the derivation
  // floors the displayed rail at it. The honest "N / M sessions" count still
  // grows (more sessions really were found) — only the rail is held monotonic.
  minOverallPct?: number;
  /** ISS-4716: the polled transcript-sync status backing the footer line. */
  transcriptSync?: TranscriptSyncStatusRead;
  /**
   * ISS-6241 (ISS-4779 closed-by-default): surface the Compute step's real
   * per-session counts. Off by default and absent in every existing caller, in
   * which case the step renders exactly as it does today.
   */
  showComputeProgress?: boolean;
};

const HARNESS_LABELS: Record<string, string> = {
  claude: "Claude Code",
  codex: "Codex",
  cursor: "Cursor",
  copilot: "Copilot",
  gemini: "Gemini CLI",
  opencode: "OpenCode",
};

/** Human label for a harness id, falling back to the raw id when unmapped. */
export function harnessLabel(id: string): string {
  return HARNESS_LABELS[id] ?? id;
}

/**
 * The same map, but an id we have no label for is title-cased rather than shown
 * as the raw lowercase slug — matching `harnessLabel` in
 * `packages/app/packs/components/pack-meta.tsx`.
 *
 * Two readers over ONE map rather than two maps: the labels themselves can never
 * drift, only the unmapped fallback differs. The import splash keeps the raw-id
 * fallback (its rows come from the collectors' closed set, all mapped); the
 * guest tour's "Harnesses found" row reads the local store, which can hold any
 * recorded string, and `windsurf` sitting next to "Claude Code" reads as a bug.
 */
export function harnessDisplayLabel(id: string): string {
  const mapped = HARNESS_LABELS[id];
  if (mapped) {
    return mapped;
  }
  return id.charAt(0).toUpperCase() + id.slice(1);
}

// Map a per-harness ingest row to a display row. The aggregate stall (`failed`)
// is NOT a per-harness signal — the runtime payload does not identify which
// harness wedged, and imports overlap — so we never brand an individual row as
// errored on stall (that would blame whichever in-progress row sorts first).
// The failure is surfaced at the aggregate level (the Failed Alert + stepper
// dot); a finished row still reads done, an in-flight row still reads active.
function toHarnessProgress(row: HarnessIngest): HarnessProgress {
  const { processed, total, pct } = describeImportProgress(
    row.processed,
    row.total
  );
  let state: StepState = "pending";
  if (total > 0 && processed >= total) {
    state = "done";
  } else if (processed > 0) {
    state = "active";
  }
  return {
    id: row.harness,
    label: harnessLabel(row.harness),
    total,
    processed,
    pct,
    state,
  };
}

/**
 * ISS-6241: the live compute step's real population, or `null`.
 *
 * Gated on `showComputeProgress` (the Labs flag) and on the payload actually
 * carrying BOTH counts — `parseMaintenanceProgress` guarantees they arrive
 * together or not at all, and this re-checks rather than assuming, because the
 * cost of being wrong is a fabricated denominator on screen. Nothing is derived
 * here: a total the producer did not send is not invented from `total`,
 * `processed`, or the import's own transcript count.
 */
function computeProgressForMaintenance(
  maintenance: MaintenanceProgress | null,
  showComputeProgress: boolean
): ComputeProgress | null {
  if (!(showComputeProgress && maintenance?.active)) {
    return null;
  }
  // The wire contract now discriminates on the phase, so the counts are only
  // reachable through the one phase that can substantiate them — this narrowing
  // is what the type demands rather than an extra defensive check.
  if (maintenance.phase !== MaintenancePhase.Rebuild) {
    return null;
  }
  const { processed, total } = maintenance;
  if (processed === undefined || total === undefined) {
    return null;
  }
  return { processed, total };
}

/**
 * Which Compute sub-step a reported phase lights up.
 *
 * `null` is returned only for a phase-less payload, and callers must pair it
 * with {@link ImportSplashState.maintenanceActive} to know which of the two
 * meanings applies — see {@link COMPUTE_STEP_BY_MAINTENANCE_PHASE} for why the
 * mapping is exhaustive rather than a fallthrough.
 */
function computeStepForMaintenance(
  maintenance: MaintenanceProgress | null
): ComputeStep | null {
  const phase = maintenance?.phase;
  if (!phase) {
    return null;
  }
  return COMPUTE_STEP_BY_MAINTENANCE_PHASE[phase];
}

function activeStepForPhase(phase: ImportPhase): PhaseStep {
  if (phase === ImportPhase.Scanning) {
    return PhaseStep.Scan;
  }
  if (phase === ImportPhase.Ready) {
    return PhaseStep.Ready;
  }
  if (phase === ImportPhase.Computing) {
    return PhaseStep.Compute;
  }
  // Importing and Failed both live on the Import step.
  return PhaseStep.Import;
}

/**
 * ISS-5281 (review): which step wears the error dot on the failed state. Pinning
 * it to Import always made the stepper argue with the headline — Scan rendered a
 * green check while the headline said the scan is what could not finish. The
 * import is the thing that stopped only when sessions were actually left behind
 * (`remaining > 0`); otherwise every discovered transcript reached a terminal
 * outcome and it is the SOURCE SCAN that never produced its population, so the
 * dot belongs on Scan.
 */
function failedStepForShortfall(processed: number, total: number): PhaseStep {
  return total > 0 && total - processed > 0 ? PhaseStep.Import : PhaseStep.Scan;
}

// The detail line during import names the tool being read right now rather than
// repeating the session count (which lives on the progress bar).
function importingDetail(perHarness: readonly HarnessProgress[]): string {
  const active = perHarness.find((harness) => harness.state === "active");
  return active
    ? `Reading your ${active.label} sessions`
    : "Reading your sessions";
}

function headlineForPhase(
  phase: ImportPhase,
  paused: boolean,
  couldNotImportCount: number
): string {
  if (paused && phase === ImportPhase.Importing) {
    return "Import paused";
  }
  switch (phase) {
    case ImportPhase.Scanning:
      return "Scanning your local logs";
    case ImportPhase.Importing:
      return "Importing your agent history";
    case ImportPhase.Computing:
      // ISS-4716: "Finishing up" promised imminence this phase cannot keep — it
      // is the DATA_REVISION rebuild, which runs for hours. Name the work
      // instead of implying it is nearly done.
      return "Building your history timeline";
    default:
      // ISS-5281 (review): an all-clear headline directly above a warning that
      // says N transcripts could not be read overclaims. The run DID reach the
      // end, so Ready is still the right phase — the headline just stops
      // promising that everything landed.
      return couldNotImportCount > 0 ? "Import finished" : "You are all set";
  }
}

function detailForPhase(
  phase: ImportPhase,
  perHarness: readonly HarnessProgress[]
): string {
  if (phase === ImportPhase.Scanning) {
    return "Looking for Claude Code, Codex, Cursor, and other agent runs on this device";
  }
  if (phase === ImportPhase.Importing) {
    return importingDetail(perHarness);
  }
  if (phase === ImportPhase.Computing) {
    // ISS-4716: "while we get your dashboard ready" implied the dashboard was
    // gated on this work; it is not, and the footer two lines below already says
    // it runs in the background. Say the part the user actually needs.
    return "Your dashboard is ready to use now";
  }
  // The splash is inline (the dashboard has been behind it the whole time), so
  // it is not "opening" anything — it just settles and collapses.
  return "Your dashboard is ready";
}

function phaseForSignals(
  input: ImportSplashInput
): Exclude<ImportPhase, "failed"> {
  if (input.inMaintenancePhase) {
    return ImportPhase.Computing;
  }
  // Import finished with no maintenance to follow: the brief Ready dwell before
  // the splash collapses. A positive total that is still mid-flight stays on
  // Import; a zero-total scan stays on Scan.
  if (input.complete && input.total > 0) {
    return ImportPhase.Ready;
  }
  if (input.total > 0) {
    return ImportPhase.Importing;
  }
  return ImportPhase.Scanning;
}

/**
 * Derive the whole splash view-state from the polled signals. Pure; the splash
 * component owns the polling and lifecycle latches and hands the results here.
 */
export function deriveImportSplashState(
  input: ImportSplashInput
): ImportSplashState {
  // FEA-4156: only show a harness we actually have sessions to parse for. The
  // main producer already omits 0-total harnesses from `ingest.byHarness`, but
  // filter defensively here too so an empty (0-of-0) row can never render a
  // phantom bar. The aggregate below is derived from THIS filtered set — not the
  // banner's pre-filter `input.total`/`input.processed` — so the overall % and
  // "N/M sessions" total never count a harness we don't display.
  const perHarness = (input.ingest?.byHarness ?? [])
    .filter((row) => row.total > 0)
    .map((row) => toHarnessProgress(row));
  const filteredTotal = perHarness.reduce((sum, row) => sum + row.total, 0);
  const filteredProcessed = perHarness.reduce(
    (sum, row) => sum + row.processed,
    0
  );
  // When there are visible harness rows, trust their summed totals for the
  // aggregate so the two can never drift. Before any row registers (the
  // preparing/scan phase, total still 0) fall back to the banner's aggregate so
  // the indeterminate state is preserved.
  const { processed, total, pct } = describeImportProgress(
    perHarness.length > 0 ? filteredProcessed : input.processed,
    perHarness.length > 0 ? filteredTotal : input.total
  );
  // Hold the rail monotonic: a late-registering harness grows the denominator
  // and would drop the raw ratio, which reads as a broken (retreating) bar.
  // Floor at the running max so the fill only ever advances; clamp to 100 so a
  // stale floor can never over-fill.
  const monotonicPct = Math.min(100, Math.max(pct, input.minOverallPct ?? 0));

  // Read once, so the failed branch and the normal branch can never disagree
  // about whether a pass is running.
  const maintenanceActive = input.maintenance?.active === true;
  const couldNotImportCount = resolveCouldNotImportCount(input.ingest);
  const quarantinedByStage = resolveQuarantinedStageCounts(input.ingest);
  const couldNotImportLabel = describeQuarantinedSources(
    quarantinedByStage,
    "transcript"
  );

  if (input.failed) {
    // One function owns the whole failed message, so the headline can never
    // contradict the detail beneath it (visual-QA review).
    const failure = describeImportShortfall({
      processed,
      total,
      couldNotImportLabel,
    });
    return {
      phase: ImportPhase.Failed,
      activeStep: failedStepForShortfall(processed, total),
      computeStep: null,
      // A stopped import is not computing anything, so there is no population.
      computeProgress: null,
      overallPct: monotonicPct,
      processed,
      total,
      paused: input.paused,
      failed: true,
      inMaintenancePhase: false,
      maintenanceActive,
      headline: failure.headline,
      detail: failure.detail,
      alertTitle: failure.alertTitle,
      alertDetail: failure.alertDetail,
      perHarness,
      couldNotImportCount,
      couldNotImportLabel,
      // The footer sits outside the Failed phase's activity gate, so it renders
      // here too and needs a footnote just like every other phase.
      syncFootnote: syncFootnoteForInput(input),
    };
  }

  const phase = phaseForSignals(input);
  // During the Compute/maintenance phase the import is done, so the overall bar
  // reads 100% while the shimmer signals the remaining background work.
  const overallPct = phase === ImportPhase.Computing ? 100 : monotonicPct;
  return {
    phase,
    activeStep: activeStepForPhase(phase),
    computeStep: computeStepForMaintenance(input.maintenance),
    computeProgress: computeProgressForMaintenance(
      input.maintenance,
      input.showComputeProgress === true
    ),
    overallPct,
    processed,
    total,
    paused: input.paused,
    failed: false,
    inMaintenancePhase: phase === ImportPhase.Computing,
    maintenanceActive,
    headline: headlineForPhase(phase, input.paused, couldNotImportCount),
    detail: detailForPhase(phase, perHarness),
    // Only the failed state carries an alert; every other phase says what it has
    // to say in the headline and detail above.
    alertTitle: null,
    alertDetail: null,
    perHarness,
    couldNotImportCount,
    couldNotImportLabel,
    syncFootnote: syncFootnoteForInput(input),
  };
}

/**
 * ISS-4716: the footer's sync line. An input that has not polled yet is treated
 * as still loading rather than as a settled empty state — never a settled zero
 * before the first read lands.
 */
function syncFootnoteForInput(input: ImportSplashInput): SyncFootnoteState {
  return deriveSyncFootnoteState(input.transcriptSync ?? { state: "loading" });
}

/**
 * ISS-5281: the whole message a stopped import shows — headline, detail line, and
 * the alert beneath them — derived from the two real counts. It is ONE function
 * on purpose (visual-QA review): the headline used to be hardcoded to
 * "Import didn't finish" while the lines under it were derived, so the
 * scan-unfinished branch shouted a failure over a detail that said everything
 * imported. That is the same self-refuting shape this ticket exists to kill, just
 * one line down. One owner, one story.
 */
export type ImportFailureCopy = {
  headline: string;
  detail: string;
  /**
   * `null` when the alert has nothing the detail line has not already said — the
   * alert then carries only the way forward, rather than restating the same
   * arithmetic in a louder colour.
   */
  alertTitle: string | null;
  alertDetail: string;
};

// Failure is graceful on every branch that imported something: the import keeps
// running, so the user is never stranded. One phrasing, so it cannot drift.
const KEEP_GOING =
  "You can keep going with what imported, and we'll keep importing in the background.";
// The one branch where nothing imported, so there is no "what imported" to keep
// going with. Promising otherwise would be the UI stating something untrue.
const KEEP_TRYING = "We'll keep trying in the background.";

/**
 * ISS-5281: describe what a stopped import actually left behind.
 *
 * The alert used to hardcode "Some transcripts couldn't be read" over
 * `We stopped after ${processed} of ${total} transcripts` — wrong on both axes.
 * The NUMBER was the discovered total, not a count of anything that failed, and
 * "couldn't be read" described a population it had not measured.
 *
 * There are three populations here and the copy must not collapse them (wongk
 * review):
 *   - `processed`/`total` are SOURCE TRANSCRIPTS — the source-file units
 *     `IngestProgressTracker` counts, one per file the scan found. They are NOT
 *     sessions: OpenCode is a batch collector where one source is the whole
 *     `opencode.db`, so a single transcript can hold many sessions and calling
 *     this pair "sessions" undercounts by an unknown amount against the Sessions
 *     list the user opens seconds later. The splash has no real session tally to
 *     report, so it reports the population it actually has, in that population's
 *     own noun;
 *   - `couldNotImportLabel` describes the QUARANTINED subset of those
 *     transcripts. ISS-6115 (wongk review) made it a ready-made phrase rather
 *     than a count, because the right verb now depends on WHICH stage gave up:
 *     a wedged parse means the file could not be read, an import stall means it
 *     was read and could not be saved. Building the phrase here from a bare
 *     count is what let "couldn't be read" outlive the fact it described;
 *   - the sessions inside a quarantined transcript are UNKNOWABLE, because it
 *     never parsed. Nothing here claims a number for them.
 *
 * So each branch names the population it actually measured, and the alert only
 * speaks when it has a fact the detail line above it cannot carry.
 */
export function describeImportShortfall({
  processed,
  total,
  couldNotImportLabel,
}: {
  processed: number;
  total: number;
  couldNotImportLabel: string | null;
}): ImportFailureCopy {
  const remaining = Math.max(0, total - processed);
  const unreadable = couldNotImportLabel;
  if (total <= 0) {
    // ISS-5281 (review): `total` is the pending population of THIS boot pass —
    // `snapshot()` drops every harness with a 0 total and the first-pass gate
    // keeps an already-imported machine out of it entirely — so 0 means "this
    // pass had nothing pending", NOT "this device has no history". A returning
    // user whose scan wedges sees this line over a full Sessions list, so it is
    // scoped to the pass and claims nothing about the device. "scan" rather than
    // "read" also leaves "couldn't be read" to the quarantine copy, which is the
    // only place it is measured.
    return {
      headline: "We couldn't scan this device",
      detail: "Nothing new has been imported yet",
      alertTitle: null,
      alertDetail: KEEP_TRYING,
    };
  }
  if (remaining > 0) {
    // The detail line already carries the N-of-M, and the per-harness rows below
    // repeat that shape, so the alert adds only the quarantine count.
    return {
      headline: "Import didn't finish",
      detail: `Stopped after ${processed.toLocaleString()} of ${total.toLocaleString()} transcripts`,
      alertTitle: unreadable,
      alertDetail: KEEP_GOING,
    };
  }
  // Every discovered transcript reached a terminal outcome, so nothing was lost
  // to a halt — a source scan simply never finished, leaving the population
  // unknown.
  return {
    headline: "We couldn't finish scanning this device",
    detail: `${formatCount(processed, "transcript")} imported`,
    alertTitle: unreadable,
    alertDetail: KEEP_GOING,
  };
}

/**
 * ISS-6241 (review): every {@link MaintenancePhase} mapped to the Compute
 * sub-step it lights up — exhaustive by TYPE, not by a fallthrough.
 *
 * {@link computeSteps} is a hand-written two-entry list, so a third phase has no
 * sub-step to land on. The if/if/return-null this replaced degraded that case to
 * `null`, which the checklist reads as "wound down" and green-checks BOTH listed
 * steps — claiming work that is still running, and needing no version skew at
 * all to happen: adding the phase to the vocabulary is enough. A missing key
 * here fails `tsc` instead, at the one place that has to be taught.
 */
const COMPUTE_STEP_BY_MAINTENANCE_PHASE: Record<MaintenancePhase, ComputeStep> =
  {
    [MaintenancePhase.Rebuild]: ComputeStep.Rebuild,
    [MaintenancePhase.ArtifactLinks]: ComputeStep.Links,
  };
