/**
 * @file onboarding-local-state-source.ts
 * @description ISS-8376 — assembles the desktop-local onboarding snapshot the
 * renderer reads.
 *
 * ELECTRON-FREE ON PURPOSE. Every seam is injected, so `test:node` can execute
 * the degrade branches directly. `transcript-sync-lane-absent-status.ts` records
 * why this matters: a branch inlined in the composition root is readable but not
 * executable, and the no-measurement branch here is the one every machine takes
 * for the first seconds of onboarding.
 *
 * THE SWEEP IS ONE-SHOT AND NEVER BLOCKS A READ. `collectTranscriptByteInventory`
 * is synchronous and measured at 638 ms / 3,977 ms (10k / 100k entries), so it
 * runs in a worker and at most once per process: the corpus size is a
 * first-launch measurement, not a live metric. `read()` never awaits it — the
 * first call starts it and answers `unavailable`, and later calls answer with it
 * once it has landed.
 */

import {
  type AnalysisEtaWireShape,
  ONBOARDING_INVENTORY_NO_REVISION,
  ONBOARDING_LOCAL_STATE_CONTRACT_VERSION,
  OnboardingHarness,
  OnboardingHarnessOutcome,
  OnboardingInventoryCompleteness,
  OnboardingInventoryStatus,
  type OnboardingInventoryWire,
  type OnboardingLocalStateWire,
} from "../../shared/onboarding-local-state-contract.js";
import {
  ANALYSIS_ETA_CONTRACT_VERSION,
  AnalysisEtaKind,
  AnalysisEtaUnavailableReason,
  toAnalysisEtaWire,
} from "../../shared/transcript-analysis-eta-contract.js";
import {
  type AnalysisEtaDeps,
  type AnalysisEtaFold,
  createAnalysisEta,
} from "../transcript-sync/transcript-analysis-eta.js";
import type {
  TranscriptByteInventory,
  TranscriptHarnessOutcome,
  TranscriptInventoryCompleteness,
} from "../transcript-sync/transcript-byte-inventory-types.js";
import {
  ByteProgressKind,
  createParseProgress,
  type ParseProgressFold,
  type ParseProgressState,
} from "../transcript-sync/transcript-byte-progress.js";
import {
  runTranscriptInventorySweep,
  type TranscriptInventorySweepOptions,
} from "../transcript-sync/transcript-inventory-worker-runner.js";
import type { TranscriptSourceHarness } from "../transcript-sync/transcript-sync-types.js";
import type { OnboardingParseProgressReading } from "./onboarding-parse-progress.js";

/**
 * Every producer field this projection does NOT carry.
 *
 * Load-bearing with the witness below: a field added to
 * `TranscriptByteInventory` fails `tsc` until it is either projected or named
 * here, so a new producer field cannot be dropped at the boundary in silence.
 */
const INVENTORY_WIRE_OMITTED = [
  // Up to 20,000 rows of session ids and file keys. User data, no consumer.
  "eligibleFiles",
  // Carries a home-abbreviated path.
  "impairments",
  // Diagnostic tallies; the completeness verdicts carry the honesty signal.
  "exclusionsByReason",
  "uploadExclusionsByReason",
] as const;

/**
 * VALUE-level witnesses: every producer member mapped to its wire member.
 *
 * The keys witness below proves the projection carries every producer FIELD.
 * These prove it carries every producer VALUE, which is a different guarantee
 * and the one an `as` cast silently destroys: `readonly ("claude"|"codex"|
 * "opencode"|"gemini")[] as readonly OnboardingHarness[]` compiles clean, and
 * the widened member then reaches the renderer's closed `z.enum`, which rejects
 * it and blanks the ENTIRE measured inventory to `unavailable` — a real
 * measurement discarded with no signal, indistinguishable from "no sweep yet".
 *
 * An exhaustive `Record` cannot be written without naming every producer member,
 * so adding one fails `tsc` HERE until it is mapped.
 */
const HARNESS_TO_WIRE: Record<TranscriptSourceHarness, OnboardingHarness> = {
  claude: OnboardingHarness.Claude,
  codex: OnboardingHarness.Codex,
  opencode: OnboardingHarness.OpenCode,
};

const OUTCOME_TO_WIRE: Record<
  TranscriptHarnessOutcome,
  OnboardingHarnessOutcome
> = {
  measured: OnboardingHarnessOutcome.Measured,
  absent: OnboardingHarnessOutcome.Absent,
  disabled: OnboardingHarnessOutcome.Disabled,
  impaired: OnboardingHarnessOutcome.Impaired,
};

const COMPLETENESS_TO_WIRE: Record<
  TranscriptInventoryCompleteness,
  OnboardingInventoryCompleteness
> = {
  complete: OnboardingInventoryCompleteness.Complete,
  partial: OnboardingInventoryCompleteness.Partial,
  unavailable: OnboardingInventoryCompleteness.Unavailable,
};

/**
 * Compile-time proof that the projection covers every producer field it did not
 * explicitly omit.
 *
 * Derived from `keyof TranscriptByteInventory` and NOT from the wire type: a
 * witness over the wire's own keys is a tautology that passes while the producer
 * grows a field nobody transported.
 */
export const INVENTORY_PROJECTION_WITNESS: Record<
  Exclude<
    keyof TranscriptByteInventory,
    (typeof INVENTORY_WIRE_OMITTED)[number]
  >,
  true
> = {
  attributableRawBytes: true,
  discoveredBytes: true,
  eligibleParseBytes: true,
  enumeratedHarnesses: true,
  evidence: true,
  excludedBytes: true,
  inventoryRevision: true,
  parseCompleteness: true,
  physicalBytes: true,
  sessionsByHarness: true,
  uploadCompleteness: true,
};

export type OnboardingLocalStateSourceDeps = {
  /** Where the materialized OpenCode projection lives; the sweep's one input. */
  transcriptStateDir: () => string;
  /** This machine's cloud identity, for the renderer's own identity guard. */
  getComputeTargetId: () => string | null;
  /**
   * Injected so a test drives the degrade branches without a worker.
   *
   * Takes the runner's options rather than closing over them, so the seam a
   * test replaces is the same one production uses — a stub can assert the
   * malformed-reply reporter actually reached the runner.
   */
  runSweep?: (
    stateDir: string,
    options: TranscriptInventorySweepOptions
  ) => Promise<TranscriptByteInventory | null>;
  /**
   * Reported when the sweep worker replies with an inventory this build cannot
   * believe — a broken worker contract, not a machine that could not be
   * measured. The sweep is one-shot, so without a signal onboarding simply
   * stays unmeasured for the rest of the process with nothing naming why.
   */
  onMalformedSweepReply?: () => void;
  /**
   * ISS-8346 — the byte movement the estimate is derived from.
   *
   * Injected rather than reached for, because the producer is the collector
   * manager and this module is deliberately electron-free. Absent leaves the
   * estimate exactly where ISS-8507 left it: a fold nothing reports to, which
   * can never leave `calculating`.
   *
   * Called with the inventory's OWN harnesses, so a harness the sweep never
   * counted — Cursor, Copilot — cannot subtract bytes from a total that never
   * included them and push the parsed figure past the corpus.
   */
  readParseProgress?: (
    harnesses: readonly TranscriptSourceHarness[]
  ) => OnboardingParseProgressReading;
  /**
   * Clock and policy for the estimate fold, so a test can drive the throughput
   * window without a real one. Passed at creation and carried by `rebase`.
   */
  analysisEtaDeps?: AnalysisEtaDeps;
};

export type OnboardingLocalStateSource = {
  /**
   * The current snapshot. Never blocks: the first call starts the one-shot
   * sweep and answers `unavailable`.
   */
  read: (attemptId?: string) => OnboardingLocalStateWire;
};

export function createOnboardingLocalStateSource(
  deps: OnboardingLocalStateSourceDeps
): OnboardingLocalStateSource {
  const runSweep = deps.runSweep ?? runTranscriptInventorySweep;
  let sweepStarted = false;
  let inventory: TranscriptByteInventory | null = null;
  let fold: AnalysisEtaFold | null = null;
  // The parse lane's own fold, which owns the high-water mark and the
  // countability refusal. Held beside the estimate rather than folded into it so
  // a numerator that outruns its total withdraws the number here, where that
  // policy already lives, instead of being re-decided at this call site.
  let parseProgress: ParseProgressFold | null = null;

  const startSweepOnce = (): void => {
    if (sweepStarted) {
      return;
    }
    sweepStarted = true;
    // Deliberately not awaited: `read()` must never wait on the sweep. The
    // chain below settles every outcome itself, so nothing escapes.
    runSweep(deps.transcriptStateDir(), {
      onMalformedReply: deps.onMalformedSweepReply,
    })
      .then((measured) => {
        if (!measured) {
          return;
        }
        inventory = measured;
        // The fold closes over the inventory revision for its whole life and
        // `rebase` returns a NEW fold rather than mutating, so the handle must
        // be reassigned. Holding the old one would emit a payload whose
        // inventory and ETA disagree about which sweep they describe.
        fold = fold
          ? fold.rebase(measured)
          : createAnalysisEta(measured, deps.analysisEtaDeps);
        // Rebound in the same step: the two folds must describe one sweep, and
        // the estimate fails closed on a parse total that disagrees with its own
        // inventory rather than dividing by a denominator it was never bound to.
        parseProgress = createParseProgress(measured);
      })
      .catch(() => {
        // The runner already resolves null on every failure; this guards a
        // caller-injected sweep that rejects instead.
      });
  };

  /**
   * Feed the estimate this read's parse position.
   *
   * ON EVERY READ, not on a timer: the renderer already polls this source, and a
   * fold with a producer of its own would be a second clock to keep honest. The
   * estimate's own floors decide when the samples are worth an answer, so an
   * extra report costs a `calculating` it was already serving.
   */
  const reportParseProgress = (
    measured: TranscriptByteInventory,
    estimate: AnalysisEtaFold,
    parseFold: ParseProgressFold
  ): ParseProgressState | null => {
    const reading = deps.readParseProgress?.(measured.enumeratedHarnesses);
    if (!reading) {
      return null;
    }
    const parse = toParseState(measured, parseFold, reading.remainingBytes);
    estimate.report({
      activity: reading.activity,
      parse,
      revision: measured.inventoryRevision,
    });
    // Returned rather than re-read from `parseFold.current()`: this is the
    // position computed FOR THIS READ, and the fold's held state can still be a
    // measured high-water mark on a read whose own remainder could not be
    // stated. Transporting that would re-state a number the lane just declined
    // to state.
    return parse;
  };

  const read = (attemptId?: string): OnboardingLocalStateWire => {
    startSweepOnce();
    const measured = inventory;
    const estimate = fold;
    const parseFold = parseProgress;
    const parse =
      measured && estimate && parseFold
        ? reportParseProgress(measured, estimate, parseFold)
        : null;
    const computeTargetId = deps.getComputeTargetId();
    return {
      contractVersion: ONBOARDING_LOCAL_STATE_CONTRACT_VERSION,
      // `parse` is bound to the same sweep `inventory` is: the fold that
      // produced it was rebased onto this inventory in the same step, and both
      // are read from the same two locals above. So the numerator and the
      // denominator on the wire name one revision by construction.
      inventory: projectInventory(inventory, parse),
      // Re-derived on EVERY read: `current()` is documented pure and
      // time-dependent, so it is how a stall becomes visible. Only the sweep is
      // one-shot.
      analysisEta: fold ? toAnalysisEtaWire(fold.current()) : NO_SWEEP_ETA,
      ...(computeTargetId ? { computeTargetId } : {}),
      ...(attemptId ? { attemptId } : {}),
    };
  };

  return { read };
}

/**
 * The ETA before any sweep has landed.
 *
 * Hand-built rather than `initialState(inventory)`, which READS a real inventory
 * and so cannot describe the state where there is none. `progress-indeterminate`
 * is the honest reason: the parse lane cannot state a total, so there is no
 * denominator — exactly what that reason means.
 */
const NO_SWEEP_ETA: AnalysisEtaWireShape = {
  contractVersion: ANALYSIS_ETA_CONTRACT_VERSION,
  inventoryRevision: ONBOARDING_INVENTORY_NO_REVISION,
  kind: AnalysisEtaKind.Unavailable,
  reason: AnalysisEtaUnavailableReason.ProgressIndeterminate,
};

/**
 * Project a measured inventory, or report that there is none.
 *
 * `parse` is this read's own position in the parse lane (ISS-10624). A position
 * the lane could not state — no reading, an indeterminate remainder, a
 * numerator the fold refused — contributes NO field, because absent means "not
 * reported" on the receiving side and a zero would claim the lane has done
 * nothing.
 */
function projectInventory(
  measured: TranscriptByteInventory | null,
  parse: ParseProgressState | null
): OnboardingInventoryWire {
  if (!measured) {
    return { status: OnboardingInventoryStatus.Unavailable };
  }
  const parsedBytes =
    parse?.kind === ByteProgressKind.Measured
      ? { parsedBytes: parse.processedBytes }
      : {};
  return {
    ...parsedBytes,
    status: OnboardingInventoryStatus.Measured,
    inventoryRevision: measured.inventoryRevision,
    parseCompleteness: COMPLETENESS_TO_WIRE[measured.parseCompleteness],
    uploadCompleteness: COMPLETENESS_TO_WIRE[measured.uploadCompleteness],
    discoveredBytes: measured.discoveredBytes,
    eligibleParseBytes: measured.eligibleParseBytes,
    excludedBytes: measured.excludedBytes,
    physicalBytes: measured.physicalBytes,
    attributableRawBytes: measured.attributableRawBytes,
    enumeratedHarnesses: measured.enumeratedHarnesses.map(
      (harness) => HARNESS_TO_WIRE[harness]
    ),
    evidence: measured.evidence.map((entry) => ({
      harness: HARNESS_TO_WIRE[entry.harness],
      outcome: OUTCOME_TO_WIRE[entry.outcome],
    })),
    sessionsByHarness: measured.sessionsByHarness.map((entry) => ({
      harness: HARNESS_TO_WIRE[entry.harness],
      sessionCount: entry.sessionCount,
    })),
  };
}

/**
 * The parse lane's position, expressed against the inventory the estimate is
 * bound to.
 *
 * The importer reports what is LEFT, and the lane's fold takes what is DONE, so
 * the subtraction happens here and nowhere else. It is floored at zero because
 * the two figures come from different enumerations — the sweep measures every
 * transcript on disk, the importer counts the sources one pass is about to read
 * — and a remainder larger than the corpus is a disagreement between them, not a
 * negative amount of work.
 *
 * A remainder nobody could state is withdrawn rather than filled in. Assuming
 * "none left" there is the false completion the whole estimate exists to refuse,
 * and assuming "all left" would restart the countdown from zero on a machine
 * that has been importing for an hour.
 */
function toParseState(
  measured: TranscriptByteInventory,
  parseFold: ParseProgressFold,
  remainingBytes: number | null
): ParseProgressState {
  if (remainingBytes === null) {
    return { kind: ByteProgressKind.Indeterminate };
  }
  const processedBytes = Math.max(
    0,
    measured.eligibleParseBytes - remainingBytes
  );
  return parseFold.report(measured.inventoryRevision, processedBytes);
}
