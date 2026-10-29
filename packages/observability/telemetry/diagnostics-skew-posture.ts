/**
 * @file diagnostics-skew-posture.ts
 * @description ISS-7488 — the compile-time keys-covered guard over
 * `desktopTelemetryDiagnosticsSchema`: every diagnostics branch must state what
 * it does with a payload from a desktop newer than this deploy.
 *
 * ## Why a table rather than a comment
 *
 * `desktopTelemetryEventSchema` validates the WHOLE event. A single field that
 * refuses a value a newer desktop emits does not drop that field — it drops the
 * event, every other diagnostic riding on it, and re-drops it on every retry,
 * while the producer's own tests stay green because the in-process path never
 * runs the wire schema. Thirty-three production events were lost that way over
 * the 30 days to 2026-09-14, across four fields, and nothing in the schema made
 * the author of a fifth think about it.
 *
 * The record below is typed `Record<keyof <shape>, DiagnosticsSkewPosture>`, so
 * adding a branch to the diagnostics schema fails `tsc` until its posture is
 * stated. That is the whole point: {@link DiagnosticsSkewPosture.CanRefuseUnknown}
 * is a legitimate answer, but it has to be a decision rather than a default.
 *
 * ## What it does NOT do
 *
 * It cannot prove a branch keeps its promise — a field declared `FoldsUnknown`
 * that later regains a closed `z.enum` still compiles. That half is covered by
 * behavior: `__tests__/telemetry-skew-tolerance.test.ts` parses an unrecognised
 * value through the folding branches and asserts the whole payload survives, and
 * `scripts/lint/rules/no-unmirrored-desktop-telemetry-enum.ts` fails CI on a
 * producer-side member an ingest const lacks.
 */

import type { desktopTelemetryDiagnosticsSchema } from "./schema";

/** What a diagnostics branch does with a value only a newer desktop can emit. */
export const DiagnosticsSkewPosture = {
  /**
   * Numbers, booleans, free text, or a `.passthrough()` — nothing in the branch
   * is a closed set, so no member a newer producer invents can fail it.
   */
  NoBoundedVocabulary: "no_bounded_vocabulary",
  /**
   * Every bounded vocabulary in the branch coarsens an unrecognised member onto
   * its own `Unknown` rather than failing the event.
   */
  FoldsUnknown: "folds_unknown",
  /**
   * At least one bounded vocabulary in the branch still REFUSES an unrecognised
   * member, so a newer producer can still cost the whole payload. Choose it only
   * where forwarding is worse than losing the event — `storeIntegrity` is the
   * worked case, where the issue category is what bounds the free-text `object`
   * slot beside it — and say why at the field.
   */
  CanRefuseUnknown: "can_refuse_unknown",
} as const;

export type DiagnosticsSkewPosture =
  (typeof DiagnosticsSkewPosture)[keyof typeof DiagnosticsSkewPosture];

type DesktopDiagnosticsField =
  keyof typeof desktopTelemetryDiagnosticsSchema.shape;

/**
 * Every branch of the desktop diagnostics payload, and its posture toward a
 * producer this deploy has not caught up with.
 *
 * Adding a field to `desktopTelemetryDiagnosticsSchema` without adding a row
 * here is a type error. Kept in the schema's own order so the two read together.
 *
 * A `CanRefuseUnknown` row is a statement about the branch, not about the field
 * this ticket fixed: `tokenCostPricingMiss` folds its `surface` and still
 * refuses an unrecognised `reason`, and `storeIntegrity` folds its check names
 * and still refuses an unrecognised issue category. None of those refusals
 * rejected a production event in the measured window; they are what the next
 * skew incident would come from.
 */
export const DESKTOP_DIAGNOSTICS_SKEW_POSTURE: Record<
  DesktopDiagnosticsField,
  DiagnosticsSkewPosture
> = {
  logTail: DiagnosticsSkewPosture.NoBoundedVocabulary,
  exitCode: DiagnosticsSkewPosture.NoBoundedVocabulary,
  planSource: DiagnosticsSkewPosture.CanRefuseUnknown,
  tokenUsage: DiagnosticsSkewPosture.NoBoundedVocabulary,
  stderrTail: DiagnosticsSkewPosture.NoBoundedVocabulary,
  exitSignal: DiagnosticsSkewPosture.NoBoundedVocabulary,
  elapsedMs: DiagnosticsSkewPosture.NoBoundedVocabulary,
  stdoutBytes: DiagnosticsSkewPosture.NoBoundedVocabulary,
  abortReason: DiagnosticsSkewPosture.NoBoundedVocabulary,
  diagnosticsVersion: DiagnosticsSkewPosture.NoBoundedVocabulary,
  decisionTableVerification: DiagnosticsSkewPosture.CanRefuseUnknown,
  desktopUpdate: DiagnosticsSkewPosture.FoldsUnknown,
  /** `result` is a closed pair the producer picks from. */
  desktopShutdown: DiagnosticsSkewPosture.CanRefuseUnknown,
  pluginUpdate: DiagnosticsSkewPosture.CanRefuseUnknown,
  outboundNetwork: DiagnosticsSkewPosture.FoldsUnknown,
  /** `reason` folds; `outcome` is closed. */
  supportUpload: DiagnosticsSkewPosture.CanRefuseUnknown,
  loopPerf: DiagnosticsSkewPosture.NoBoundedVocabulary,
  lifecycle: DiagnosticsSkewPosture.NoBoundedVocabulary,
  /** ISS-7488 folded `surface`; `reason` is still closed. */
  tokenCostPricingMiss: DiagnosticsSkewPosture.CanRefuseUnknown,
  /** ISS-7488 folded the check names; the issue category is still closed. */
  storeIntegrity: DiagnosticsSkewPosture.CanRefuseUnknown,
  storePerf: DiagnosticsSkewPosture.CanRefuseUnknown,
  migrationStep: DiagnosticsSkewPosture.CanRefuseUnknown,
  spawnMeta: DiagnosticsSkewPosture.NoBoundedVocabulary,
  dbHostExit: DiagnosticsSkewPosture.NoBoundedVocabulary,
  collectorRecordsDropped: DiagnosticsSkewPosture.FoldsUnknown,
  distributionInstallGaveUp: DiagnosticsSkewPosture.CanRefuseUnknown,
  invocationSyncMissingParents: DiagnosticsSkewPosture.FoldsUnknown,
  syncLaneStall: DiagnosticsSkewPosture.FoldsUnknown,
  dbHostTelemetryRefused: DiagnosticsSkewPosture.CanRefuseUnknown,
  dbHostReplyRejected: DiagnosticsSkewPosture.CanRefuseUnknown,
  harnessResultEnvelopesDropped: DiagnosticsSkewPosture.CanRefuseUnknown,
  rendererHealth: DiagnosticsSkewPosture.CanRefuseUnknown,
  localReadFailed: DiagnosticsSkewPosture.FoldsUnknown,
  syncLaneGaveUp: DiagnosticsSkewPosture.FoldsUnknown,
  syncLaneReArmed: DiagnosticsSkewPosture.FoldsUnknown,
};
