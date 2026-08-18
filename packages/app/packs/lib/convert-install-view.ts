/**
 * Pure view-model + phase state machine for the convert→install preview/confirm
 * Sheet (FEA-4080).
 *
 * The Sheet reads the FEA-4078 capability dry-run (`planConversionDryRun` /
 * `resolveConversionCapability` — "what WOULD this convert do?") and executes it
 * through the FEA-4079 convert engine (`window.desktopApi.db.catalogConvertInstall`,
 * injected as a callback so this shared `@repo/app/packs` module stays
 * surface-agnostic and never reaches for `window`). This module owns the two
 * pieces of pure logic the render needs, extracted so they are unit-testable
 * without a DOM (per the reviewed convert prototype's `install-phase.ts`):
 *
 *  1. `ConvertInstallSummaryState` — the honest, non-color-only summary state the
 *     Sheet draws BEFORE the user confirms: `clean` / `partial` / `unsupported`
 *     / `offline`, plus the in-flight `converting` and terminal `error`. It is
 *     the pre-execution capability verdict (`ConversionSupport`) collapsed with
 *     the target's reachability (offline) and the live phase.
 *  2. `ConvertInstallPhase` — the confirm-driven phase machine: `preview` (the
 *     resting summary + field breakdown), `converting` (in flight), `done`
 *     (installed, possibly `partial`), `error` (retryable). A blocked summary
 *     (unsupported / offline) can never advance out of `preview`.
 *
 * Both are const-object enums (never a TS `enum`, never bare literals), and every
 * mapper is exhaustive over its union (`never` guard) so a new member fails
 * `tsc` until it is handled — the same discipline `installStateTreatment`
 * (FEA-4083) uses.
 *
 * The summary state deliberately REUSES the FEA-4083 `PackInstallState`
 * vocabulary for its rendered treatment (icon shape + label, non-color-only) via
 * `summaryPackInstallState`, so the Sheet's states draw with the exact same
 * status-icon language every other packs surface already uses — the two never
 * drift into two different "converting" glyphs.
 */

import type { ConvertFailureClass } from "@repo/api/src/types/convert-install";
import {
  ConvertInstallState,
  isPermanentFailure,
} from "@repo/api/src/types/convert-install";
import type { ConversionCapability } from "@repo/api/src/types/harness-conversion";
import { ConversionSupport } from "@repo/api/src/types/harness-conversion";
import { PackInstallState } from "./install-state";

/**
 * The honest state the convert→install Sheet summarizes for the user, said with
 * an icon SHAPE + a label (never color alone). It collapses three independent
 * inputs into one member the header banner and confirm button both read from:
 *  - the FEA-4078 capability verdict (`supported` / `partial` / `unsupported`);
 *  - the target's reachability (an offline target can't be converted-installed);
 *  - the live install phase (in-flight / failed).
 *
 * `Clean` and `Partial` are both installable (partial requires an explicit
 * confirm past the loss warning); `Unsupported` and `Offline` are blocked with a
 * reason; `Converting` is in flight; `Error` is a retryable failure.
 */
export const ConvertInstallSummaryState = {
  /** Converts losslessly — every source field carries to the target. */
  Clean: "clean",
  /** Converts lossily — named fields will be dropped; confirm required. */
  Partial: "partial",
  /** No conversion exists for this kind on this harness pair — blocked. */
  Unsupported: "unsupported",
  /** The target device is offline — can't convert-install to it; blocked. */
  Offline: "offline",
  /** The convert + install is in flight. */
  Converting: "converting",
  /** The convert or install failed — retryable. */
  Error: "error",
} as const;
export type ConvertInstallSummaryState =
  (typeof ConvertInstallSummaryState)[keyof typeof ConvertInstallSummaryState];

/**
 * The confirm-driven install phase. `Preview` is the resting summary; `Error` is
 * also shown over the preview (retryable back into `Converting`). `Converting`
 * is in flight; `Done` is terminal (a clean OR partial install both land here —
 * the outcome's dropped fields decide which copy shows).
 */
export const ConvertInstallPhase = {
  Preview: "preview",
  Converting: "converting",
  Done: "done",
  Error: "error",
} as const;
export type ConvertInstallPhase =
  (typeof ConvertInstallPhase)[keyof typeof ConvertInstallPhase];

/**
 * Resolve the pre-execution summary state from the capability verdict and the
 * target's reachability. Offline wins over the capability verdict: a convert
 * that WOULD succeed still can't run against an unreachable target, so the Sheet
 * blocks it with the honest "offline" reason rather than offering a confirm that
 * would immediately fail. Exhaustive over `ConversionSupport`.
 */
export function resolveConvertInstallSummaryState(params: {
  readonly capability: ConversionCapability;
  readonly targetOffline: boolean;
}): ConvertInstallSummaryState {
  if (params.targetOffline) {
    return ConvertInstallSummaryState.Offline;
  }
  switch (params.capability.support) {
    case ConversionSupport.Supported: {
      return ConvertInstallSummaryState.Clean;
    }
    case ConversionSupport.Partial: {
      return ConvertInstallSummaryState.Partial;
    }
    case ConversionSupport.Unsupported: {
      return ConvertInstallSummaryState.Unsupported;
    }
    default: {
      return assertExhaustiveSupport(params.capability.support);
    }
  }
}

/**
 * `true` when a summary state blocks install (the confirm button is disabled and
 * the reason banner explains why). Both `Unsupported` and `Offline` block; every
 * other state is either installable or already running.
 */
export function isBlockedSummaryState(
  state: ConvertInstallSummaryState
): boolean {
  return (
    state === ConvertInstallSummaryState.Unsupported ||
    state === ConvertInstallSummaryState.Offline
  );
}

/**
 * `true` when confirming the install requires an EXPLICIT extra acknowledgement
 * of loss — the `partial` (lossy) case. A clean convert installs on the first
 * confirm; a partial one makes the user confirm past the dropped-field warning.
 */
export function requiresLossConfirm(
  state: ConvertInstallSummaryState
): boolean {
  return state === ConvertInstallSummaryState.Partial;
}

/**
 * The FEA-4083 `PackInstallState` whose canonical status-icon treatment + label
 * the Sheet reuses to draw this summary state, so the convert flow speaks the
 * exact same non-color-only status language as every other packs surface. Maps
 * `clean → Installed` glyph is deliberately NOT used (nothing is installed yet at
 * summary time); instead a clean/partial preview reads as `NotInstalled` (the
 * empty, actionable ring), the blocked states reuse `Unsupported`/`Offline`, and
 * the live/failed states reuse `Converting`/`Failed`. Exhaustive over the union.
 */
export function summaryPackInstallState(
  state: ConvertInstallSummaryState
): PackInstallState {
  switch (state) {
    case ConvertInstallSummaryState.Clean: {
      return PackInstallState.NotInstalled;
    }
    case ConvertInstallSummaryState.Partial: {
      return PackInstallState.NotInstalled;
    }
    case ConvertInstallSummaryState.Unsupported: {
      return PackInstallState.Unsupported;
    }
    case ConvertInstallSummaryState.Offline: {
      return PackInstallState.Offline;
    }
    case ConvertInstallSummaryState.Converting: {
      return PackInstallState.Converting;
    }
    case ConvertInstallSummaryState.Error: {
      return PackInstallState.Failed;
    }
    default: {
      return assertExhaustiveSummary(state);
    }
  }
}

/**
 * The phase confirm transitions to. A no-op on a blocked summary (unsupported /
 * offline) or while already converting — so the button's disabled state and the
 * transition can never disagree. Otherwise it starts the convert.
 */
export function phaseAfterConfirm(params: {
  readonly phase: ConvertInstallPhase;
  readonly summaryState: ConvertInstallSummaryState;
}): ConvertInstallPhase {
  if (
    isBlockedSummaryState(params.summaryState) ||
    params.phase === ConvertInstallPhase.Converting
  ) {
    return params.phase;
  }
  return ConvertInstallPhase.Converting;
}

/**
 * The summary state to DISPLAY given the resting (pre-execution) summary and the
 * live phase. The live phase wins while it is meaningful: `Converting` and
 * `Error` are runtime states the resting summary can't express, so they override
 * it. `Preview` (and the terminal `Done`, which the Sheet draws with its own
 * success body rather than a summary token) fall through to the resting summary.
 * This is what the header status-icon reads, so the shared FEA-4083 treatment
 * tracks the live flow, not just the initial verdict.
 */
export function displaySummaryState(params: {
  readonly summaryState: ConvertInstallSummaryState;
  readonly phase: ConvertInstallPhase;
}): ConvertInstallSummaryState {
  if (params.phase === ConvertInstallPhase.Converting) {
    return ConvertInstallSummaryState.Converting;
  }
  if (params.phase === ConvertInstallPhase.Error) {
    return ConvertInstallSummaryState.Error;
  }
  return params.summaryState;
}

/**
 * The confirm-phase the Sheet lands in for a resolved engine outcome
 * (FEA-4079 `ConvertInstallState`). Terminal installs — `Installed` and the
 * honest lossy `Partial` — become `Done`. A `Converting` outcome is the engine
 * reporting the run was LAUNCHED and is still streaming to completion via the
 * existing IPC path (a clean convert returns this, per
 * `apps/desktop/src/main/packs/convert-engine.ts`); the Sheet must NOT claim the
 * install finished, so it stays in `Converting` (spinner + sealed dismiss) rather
 * than falsely painting `Done`. `Error` — and the permanent `Unsupported`, which
 * should not appear post-launch but is mapped defensively — surface the retryable
 * error phase. Exhaustive over `ConvertInstallState`.
 */
export function convertInstallPhaseForOutcome(
  state: ConvertInstallState
): ConvertInstallPhase {
  switch (state) {
    case ConvertInstallState.Installed: {
      return ConvertInstallPhase.Done;
    }
    case ConvertInstallState.Partial: {
      return ConvertInstallPhase.Done;
    }
    case ConvertInstallState.Converting: {
      return ConvertInstallPhase.Converting;
    }
    case ConvertInstallState.Error: {
      return ConvertInstallPhase.Error;
    }
    case ConvertInstallState.Unsupported: {
      return ConvertInstallPhase.Error;
    }
    default: {
      return assertExhaustiveOutcome(state);
    }
  }
}

/**
 * Whether the Sheet should keep an ENABLED retry ("Try again") for a failed
 * convert-install, given the outcome's {@link ConvertFailureClass}. Retry stays
 * available only for a TRANSIENT failure (the same request could succeed later)
 * or an UNCLASSIFIED one (`undefined` — an older desktop producer that predates
 * `failureClass`, which must degrade safely to retryable per the cross-repo
 * compatibility rule). A PERMANENT failure (invalid request, missing catalog
 * command, invalid/missing working directory — including the `NotApplicable`
 * unsupported subtype) can never succeed on retry, so the Sheet must not offer an
 * enabled retry that would immediately fail again (wongk review). A rejected
 * engine call (no outcome, hence no class) is treated as transient/unclassified.
 */
export function isRetryableFailure(
  failureClass: ConvertFailureClass | undefined
): boolean {
  if (failureClass === undefined) {
    return true;
  }
  return !isPermanentFailure(failureClass);
}

/**
 * A stable React key for the full CONVERSION IDENTITY of a convert-install
 * target — not just its `packId`. The Sheet body owns per-attempt phase + outcome
 * state; keying its remount by `packId` alone let the SAME pack switch harness
 * targets (or source format) while the Sheet stayed mounted without resetting,
 * so an in-flight result from the OLD conversion could paint "Done" against the
 * NEW target. Keying by every axis the engine converts on (`packId`,
 * `currentHarness`, `targetHarness`, and the `sourceHarness` provenance) forces a
 * fresh state machine the moment any axis changes, so a stale completion can
 * never land on a different conversion (wongk review). Field order is fixed and
 * the axes are `HarnessName` enum values (no separators collide).
 */
export function conversionIdentityKey(target: {
  readonly packId: string;
  readonly currentHarness: string;
  readonly targetHarness: string;
  readonly sourceHarness?: string;
}): string {
  return [
    target.packId,
    target.currentHarness,
    target.targetHarness,
    target.sourceHarness ?? target.currentHarness,
  ].join("|");
}

const assertExhaustiveSupport = (
  support: never
): ConvertInstallSummaryState => {
  throw new Error(`Unhandled ConversionSupport: ${String(support)}`);
};

const assertExhaustiveSummary = (state: never): PackInstallState => {
  throw new Error(`Unhandled ConvertInstallSummaryState: ${String(state)}`);
};

const assertExhaustiveOutcome = (state: never): ConvertInstallPhase => {
  throw new Error(`Unhandled ConvertInstallState: ${String(state)}`);
};
