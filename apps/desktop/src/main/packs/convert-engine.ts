/**
 * @file convert-engine.ts
 * @description The harness-format convert engine (FEA-4079).
 *
 * SECURITY: this runs in the desktop gateway (main process) because it operates
 * on the local component files and drives `streamRun`, which spawns the vetted
 * install subprocess. Per the repo rule, convert+install is NOT reimplemented in
 * `apps/app`/`apps/api` — those have no local filesystem access. This engine is
 * the ONLY place the convert step exists.
 *
 * What it does, as ONE gateway operation:
 *  1. CONVERT (net-new) — resolve the pre-execution {@link ConversionCapability}
 *     for the component's `(kind, currentHarness → targetHarness)` triple from
 *     the canonical FEA-4078 capability map. This is the truthful "can this
 *     convert, and what is lost?" answer. No new capability logic is invented
 *     here; the map is the single source of truth.
 *  2. INSTALL (reused) — for a convertible component, run the EXISTING catalog
 *     install path (`streamRun`) so a convert-install is one operation, not a
 *     new install stack. The install's trust model is unchanged: commands come
 *     only from the vetted local `pack_catalog`.
 *
 * Honest state at the execution boundary: the engine reports converting →
 * installed for a lossless convert, `partial` for a lossy one (installed with
 * named dropped fields — never a silent lossy write), `unsupported` for an
 * impossible one (nothing installed), and `error` split into transient
 * (retryable) vs permanent (`not_applicable`) per `apps/desktop/AGENTS.md`.
 *
 * Provenance (FEA-4028): the original `sourceHarness` the component was authored
 * for is preserved onto the converted identity untouched — defaulting to
 * `currentHarness` for a never-converted component — so a component always
 * records where it came from across repeated conversions, without re-charging
 * losses from a prior hop.
 */

import {
  ConvertFailureClass,
  type ConvertInstallOutcome,
  type ConvertInstallRequest,
  ConvertInstallState,
} from "@repo/api/src/types/convert-install.ts";
import {
  ConversionSupport,
  type ConvertedComponentIdentity,
  resolveConversionCapability,
} from "@repo/api/src/types/harness-conversion.ts";
import type { HarnessName } from "@repo/crewd/model";
import {
  classifyStreamRunRetry,
  type StreamRunResult,
  StreamRunRetryClass,
} from "../../shared/install-run-contract.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * The install callback the engine reuses. Matches the existing
 * `catalog-install` streamRun signature (packId, harness, cwd) so the engine
 * wires into the SAME install path rather than a parallel one. Returns the
 * `StreamRunResult` (or null when the runtime is not ready yet — a transient
 * condition).
 */
export type ConvertInstallRunner = (
  packId: string,
  harness: HarnessName,
  cwd?: string
) => Promise<StreamRunResult | null>;

// ---------------------------------------------------------------------------
// streamRun error-code classification (transient vs permanent)
// ---------------------------------------------------------------------------

/**
 * Project the canonical retry axis onto this engine's `ConvertFailureClass`.
 *
 * The classification itself lives with the PRODUCER's vocabulary in
 * `shared/install-run-contract.ts` (`classifyStreamRunRetry`), where it is
 * pinned exhaustive against `StreamRunErrorCode` — a new code added there
 * without a class fails `tsc` rather than quietly falling through as transient
 * (wongk's concern that "the next permanent code quietly falls through"). The
 * distribution installer derives its log LEVEL from that same source, so the two
 * consumers cannot drift into disagreeing about what counts as a real failure.
 *
 * This `Record` is exhaustive over the retry axis for the same reason: a new
 * retry class cannot be added without deciding what it means here.
 */
const RETRY_CLASS_TO_FAILURE_CLASS: Record<
  StreamRunRetryClass,
  ConvertFailureClass
> = {
  [StreamRunRetryClass.Transient]: ConvertFailureClass.Transient,
  [StreamRunRetryClass.Permanent]: ConvertFailureClass.Permanent,
};

/** Classify a `StreamRunResult` error code onto the retry-eligibility axis. */
export function classifyStreamRunError(
  code: string | undefined
): ConvertFailureClass {
  return RETRY_CLASS_TO_FAILURE_CLASS[classifyStreamRunRetry(code)];
}

// ---------------------------------------------------------------------------
// Core: convertInstall
// ---------------------------------------------------------------------------

/**
 * Convert-install one component as a single gateway operation.
 *
 * The convert step resolves the capability from the FEA-4078 map on the
 * component's CURRENT format (not its original provenance, so an already-once
 * converted component is not charged again for a prior hop's loss). Then:
 *  - `Unsupported` → nothing is installed; returns `Unsupported` with the
 *    permanent `not_applicable` class (the convert can never apply here).
 *  - `Supported` / `Partial` → runs the EXISTING install path via `runInstall`.
 *    A launched install returns `Converting` (the run streams to completion via
 *    the existing IPC path); `Partial` carries the dropped fields so the state
 *    is honest about the loss. An install rejection returns `Error` with the
 *    transient/permanent class from {@link classifyStreamRunError}.
 *
 * Provenance is preserved onto the returned identity untouched.
 */
export async function convertInstall(
  request: ConvertInstallRequest,
  runInstall: ConvertInstallRunner
): Promise<ConvertInstallOutcome> {
  const { kind, currentHarness, targetHarness } = request;
  const sourceHarness = request.sourceHarness ?? currentHarness;
  const identity: ConvertedComponentIdentity = {
    id: request.packId,
    name: request.name,
    kind,
    sourceHarness,
    currentHarness,
    targetHarness,
  };

  const capability = resolveConversionCapability(
    kind,
    currentHarness,
    targetHarness
  );

  // Unsupported → a permanent impossibility. Nothing is installed; never a
  // silent no-op dressed as success.
  if (capability.support === ConversionSupport.Unsupported) {
    return {
      state: ConvertInstallState.Unsupported,
      identity,
      capability,
      droppedFields: [],
      failureClass: ConvertFailureClass.NotApplicable,
      message: `Cannot convert a ${kind} from ${currentHarness} to ${targetHarness}: no conversion exists for this component kind on this harness pair.`,
    };
  }

  // Supported or Partial → run the existing install path. `streamRun` can REJECT
  // before it returns a StreamRunResult when its catalog or run-record DB calls
  // throw; that rejection would otherwise walk through `withDb`/`invokeLiveDb` and
  // hand the renderer a rejected IPC promise instead of the typed error outcome
  // this operation promises. Catch it and default an unknown infrastructure
  // failure to transient (retry once the DB/runtime recovers).
  let result: StreamRunResult | null;
  try {
    result = await runInstall(request.packId, targetHarness, request.cwd);
  } catch (error: unknown) {
    return {
      state: ConvertInstallState.Error,
      identity,
      capability,
      droppedFields: [],
      failureClass: ConvertFailureClass.Transient,
      message:
        error instanceof Error && error.message
          ? `Convert-install failed to start: ${error.message}`
          : "Convert-install failed to start due to an unexpected local error. Try again.",
    };
  }

  // Runtime not ready yet — a transient condition (retry once ready).
  if (result === null) {
    return {
      state: ConvertInstallState.Error,
      identity,
      capability,
      droppedFields: [],
      failureClass: ConvertFailureClass.Transient,
      message:
        "Convert engine is not ready yet — the local runtime is still starting. Try again in a moment.",
    };
  }

  if (!result.started) {
    return {
      state: ConvertInstallState.Error,
      identity,
      capability,
      droppedFields: [],
      failureClass: classifyStreamRunError(result.error?.code),
      message: result.error?.message,
    };
  }

  // Install launched. For a Partial conversion, report `partial` and carry the
  // dropped fields so the boundary is honest that the install is lossy — NOT a
  // silent lossless success. A Supported conversion is `Converting` (the run
  // streams to completion via the existing IPC path).
  if (capability.support === ConversionSupport.Partial) {
    return {
      state: ConvertInstallState.Partial,
      identity,
      capability,
      droppedFields: capability.droppedFields,
      runId: result.runId,
      message: `Converted with loss: the ${targetHarness} format cannot carry ${describeDroppedFields(
        capability.droppedFields
      )}.`,
    };
  }

  return {
    state: ConvertInstallState.Converting,
    identity,
    capability,
    droppedFields: [],
    runId: result.runId,
  };
}

/**
 * Render the dropped-field list for a partial-conversion message. Kept small and
 * pure so the message stays engine-detail-free and stable to test.
 */
function describeDroppedFields(droppedFields: readonly string[]): string {
  if (droppedFields.length === 0) {
    return "some source fields";
  }
  return droppedFields.join(", ");
}
