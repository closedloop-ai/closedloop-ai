/**
 * @file inert-desktop-otel-runtime.ts
 * @description A fully-shaped {@link DesktopOtelRuntime} that emits nothing.
 *
 * Extracted from `fake-desktop-sync-lane-deps.ts` (ISS-9166) once the live sync
 * harness needed the same object: a runtime satisfying the whole interface
 * without starting an SDK. One copy, because the interface grows and a second
 * hand-written stub drifts silently — a missing member is a `TypeError` at the
 * first call, which in a lane that only emits on failure is a crash reachable
 * exclusively on the day something else already broke.
 *
 * `onSyncBatch` is the one tee the harness needs: `emitSyncBatchEvent` is the
 * production call every lane already makes per batch, so observing there costs
 * the hot path nothing and cannot disagree with what the lane did.
 */
import type {
  DesktopOtelRuntime,
  DesktopSyncBatchEventInput,
} from "../src/main/telemetry/app-otel-runtime.js";
import { RendererOtelExportFailureReason } from "../src/shared/renderer-otel-bridge-constants.js";

export type InertDesktopOtelRuntimeOptions = {
  /** Called with every batch event the lanes emit. */
  onSyncBatch?: (input: DesktopSyncBatchEventInput) => void;
};

export function inertDesktopOtelRuntime(
  options: InertDesktopOtelRuntimeOptions = {}
): DesktopOtelRuntime {
  return {
    start: () => Promise.resolve(),
    emitAppLifecycleEvent: () => undefined,
    emitAppExceptionEvent: () => undefined,
    emitSanitizedAppExceptionEvent: () => undefined,
    emitIpcPerfEvent: () => undefined,
    emitSyncBatchEvent: (input) => options.onSyncBatch?.(input),
    emitImportHealthEvent: () => undefined,
    emitAuthFailureEvent: () => false,
    emitDeadEndEvent: () => true,
    emitGenAiRequestEvent: () => undefined,
    emitOnboardingEvent: () => undefined,
    emitOnboardingDiscardEvent: () => undefined,
    emitUpdateEvent: () => true,
    flush: () => Promise.resolve(),
    shutdown: () => Promise.resolve(),
    getBufferedRecords: () => [],
    resetBuffer: () => undefined,
    exportExternalRecords: () => ({
      ok: false as const,
      reason: RendererOtelExportFailureReason.Unavailable,
    }),
  };
}
