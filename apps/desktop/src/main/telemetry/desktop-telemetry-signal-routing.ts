import { GenAiOperationName } from "@closedloop-ai/telemetry-contract/gen-ai";
import { DeadEndRateRecordName } from "@closedloop-ai/telemetry-contract/ipc";
import { KeylessTelemetrySignal } from "@repo/shared-platform/keyless-telemetry";
import type { DesktopOtelRuntime } from "./app-otel-runtime.js";
import { ONBOARDING_DISCARD_EVENT_NAME } from "./app-otel-runtime-onboarding-discard.js";

/**
 * One desktop telemetry record kind, named by the log-record/span name it
 * carries on the wire. `app.lifecycle` appears twice on purpose: the heartbeat
 * and the transitions are the same attribute family on two different indexes,
 * which is exactly the distinction a single per-family entry would erase.
 */
export const DesktopTelemetryRecord = {
  AppLifecycleHeartbeat: "app.lifecycle:heartbeat",
  AppLifecycleTransition: "app.lifecycle:transition",
  AppException: "exception",
  IpcPerf: "ipc.*",
  SyncBatch: "sync.batch",
  SyncBatchCount: "sync.batch.count",
  ImportHealth: "import.*",
  Onboarding: "onboarding.lifecycle",
  OnboardingDiscard: ONBOARDING_DISCARD_EVENT_NAME,
  UpdateLifecycle: "update.lifecycle",
  DeadEnd: "dead_end.treatment",
  DeadEndRate: DeadEndRateRecordName,
  AuthFailure: "auth.failure",
  GenAiRequest: GenAiOperationName.Chat,
} as const;

/** Literal union of desktop telemetry record kinds. */
export type DesktopTelemetryRecord =
  (typeof DesktopTelemetryRecord)[keyof typeof DesktopTelemetryRecord];

/**
 * The index each record lands on, and why.
 *
 * Spans where the record has a DURATION or a parent worth joining against
 * (`ipc.*`, `sync.batch`, an exception, a lifecycle transition inside the
 * activity root). Logs where it is a low-frequency counter or a discrete
 * state change with nothing to time (`import.*`, onboarding and its analytics
 * discards, update, dead ends, auth failures, and the heartbeat — high-frequency
 * liveness that would be a useless trace child). `dead_end.rate` is a log so both operands of the
 * dead-end rate come unsampled from the same builds (ISS-12039). Metrics only for
 * `sync.batch.count`, which exists because tail sampling is trace-only and a
 * sync RATE must survive a dropped span (ISS-7497). `chat` is a zero-length
 * root span for neither reason: the PostHog leg it exists to feed ingests
 * traces only (ISS-11347).
 */
export const DesktopTelemetrySignalRouting = {
  [DesktopTelemetryRecord.AppLifecycleHeartbeat]: KeylessTelemetrySignal.Logs,
  [DesktopTelemetryRecord.AppLifecycleTransition]:
    KeylessTelemetrySignal.Traces,
  [DesktopTelemetryRecord.AppException]: KeylessTelemetrySignal.Traces,
  [DesktopTelemetryRecord.IpcPerf]: KeylessTelemetrySignal.Traces,
  [DesktopTelemetryRecord.SyncBatch]: KeylessTelemetrySignal.Traces,
  [DesktopTelemetryRecord.SyncBatchCount]: KeylessTelemetrySignal.Metrics,
  [DesktopTelemetryRecord.ImportHealth]: KeylessTelemetrySignal.Logs,
  [DesktopTelemetryRecord.Onboarding]: KeylessTelemetrySignal.Logs,
  [DesktopTelemetryRecord.OnboardingDiscard]: KeylessTelemetrySignal.Logs,
  [DesktopTelemetryRecord.UpdateLifecycle]: KeylessTelemetrySignal.Logs,
  [DesktopTelemetryRecord.DeadEnd]: KeylessTelemetrySignal.Logs,
  [DesktopTelemetryRecord.DeadEndRate]: KeylessTelemetrySignal.Logs,
  [DesktopTelemetryRecord.AuthFailure]: KeylessTelemetrySignal.Logs,
  [DesktopTelemetryRecord.GenAiRequest]: KeylessTelemetrySignal.Traces,
} as const satisfies Record<DesktopTelemetryRecord, KeylessTelemetrySignal>;

/** Every `emit*` member of the runtime's export surface. */
export type DesktopTelemetryEmitMethod = Extract<
  keyof DesktopOtelRuntime,
  `emit${string}`
>;

/**
 * Which record kind(s) each emitter originates.
 *
 * The table above is only exhaustive over a union this same file declares, so on
 * its own it cannot notice a new emitter — someone would just not add a member,
 * exactly as the five ISS-8015 emitters each silently inherited an index from
 * whichever sibling was copied. Keying off `DesktopOtelRuntime` closes that:
 * adding an `emit*` method fails `tsc` here until its records are named, and the
 * value type forces those to be record kinds the routing table has an index for.
 *
 * Two entries are deliberately not 1:1. Both exception emitters land on the same
 * record — one sanitizes at emit, the other was sanitized at capture — and
 * `emitSyncBatchEvent` originates two, because ISS-7497 put the counter on the
 * metrics pipeline ahead of the span's `.strict()` parse so a sync RATE survives
 * a rejected span.
 */
export const DesktopTelemetryRecordByEmitter = {
  emitAppLifecycleEvent: [
    DesktopTelemetryRecord.AppLifecycleHeartbeat,
    DesktopTelemetryRecord.AppLifecycleTransition,
  ],
  emitAppExceptionEvent: [DesktopTelemetryRecord.AppException],
  emitSanitizedAppExceptionEvent: [DesktopTelemetryRecord.AppException],
  emitIpcPerfEvent: [DesktopTelemetryRecord.IpcPerf],
  emitSyncBatchEvent: [
    DesktopTelemetryRecord.SyncBatch,
    DesktopTelemetryRecord.SyncBatchCount,
  ],
  emitImportHealthEvent: [DesktopTelemetryRecord.ImportHealth],
  emitOnboardingEvent: [DesktopTelemetryRecord.Onboarding],
  emitOnboardingDiscardEvent: [DesktopTelemetryRecord.OnboardingDiscard],
  emitUpdateEvent: [DesktopTelemetryRecord.UpdateLifecycle],
  emitDeadEndEvent: [DesktopTelemetryRecord.DeadEnd],
  emitAuthFailureEvent: [DesktopTelemetryRecord.AuthFailure],
  emitGenAiRequestEvent: [DesktopTelemetryRecord.GenAiRequest],
} as const satisfies Record<
  DesktopTelemetryEmitMethod,
  // Non-empty by construction (whitlockk review): a plain array type accepts `[]`,
  // which would let a new emitter satisfy this map while naming no record at
  // all — passing the forcing function without ever declaring a route.
  readonly [DesktopTelemetryRecord, ...DesktopTelemetryRecord[]]
>;
