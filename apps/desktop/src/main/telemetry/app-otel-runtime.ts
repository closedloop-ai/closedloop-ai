import {
  type AgentMonitorRuntimeStatusKind,
  AppTelemetrySchema,
} from "@closedloop-ai/telemetry-contract/app";
import { TelemetryAttribute } from "@closedloop-ai/telemetry-contract/attributes";
import { createEmit } from "@closedloop-ai/telemetry-contract/emit";
import { TelemetrySchemaName } from "@closedloop-ai/telemetry-contract/schema-name";
import {
  type SyncLane,
  SyncOutcome,
  type SyncPayloadShaping,
  type SyncReason,
  SyncTelemetrySchema,
} from "@closedloop-ai/telemetry-contract/sync";
import {
  type Attributes,
  type Context,
  context,
  SpanStatusCode as OTelSpanStatusCode,
  ROOT_CONTEXT,
  type Span,
  type SpanContext,
  trace,
} from "@opentelemetry/api";
import type { NodeSDK } from "@opentelemetry/sdk-node";
import {
  type DesktopExceptionTelemetryInput,
  type SanitizedDesktopExceptionAttributes,
  sanitizeDesktopException,
} from "../../shared/exception-sanitizer.js";
import {
  type DesktopOtelBufferedRecord,
  type RendererOtelBridgeRecord,
  RendererOtelExportFailureReason,
  type RendererOtelExportResult,
} from "../../shared/renderer-otel-bridge-constants.js";
import {
  hasSpanIdentity,
  normalizeAttributes,
} from "../../shared/renderer-otel-bridge-utils.js";
import {
  AUTH_FAILURE_LOGGER_NAME,
  buildAuthFailureRecord,
  type DesktopAuthFailureEventInput,
} from "../cloud/auth-failure-telemetry.js";
import {
  DEAD_END_LOGGER_NAME,
  type DesktopDeadEndEventInput,
  emitDeadEndRecord,
} from "./app-otel-runtime-dead-end.js";
import {
  type DesktopGenAiRequestEventInput,
  emitGenAiRequestSpan,
} from "./app-otel-runtime-gen-ai.js";
import {
  buildImportHealthRecord,
  type DesktopImportHealthEventInput,
  IMPORT_HEALTH_LOGGER_NAME,
} from "./app-otel-runtime-import-health.js";
import {
  buildDesktopIpcPerfAttributes,
  type DesktopIpcPerfEventInput,
} from "./app-otel-runtime-ipc.js";
import {
  DesktopAppLifecycleEvent,
  DesktopAppOperatingMode,
  type DesktopTelemetryExportCounts,
  telemetryExportCountAttributes,
} from "./app-otel-runtime-lifecycle.js";
import {
  buildOnboardingRecord,
  type DesktopOnboardingEventInput,
  ONBOARDING_LOGGER_NAME,
} from "./app-otel-runtime-onboarding.js";
import {
  buildOnboardingDiscardRecord,
  type DesktopOnboardingDiscardEventInput,
  ONBOARDING_DISCARD_LOGGER_NAME,
} from "./app-otel-runtime-onboarding-discard.js";
import {
  rebaseRendererRecords,
  resolveRendererIdentityContext,
} from "./app-otel-runtime-renderer-bridge.js";
import {
  isOtelSdkDisabled,
  startDesktopOtelSdk,
} from "./app-otel-runtime-sdk.js";
import { buildSyncBatchAttributes } from "./app-otel-runtime-sync-batch.js";
import {
  buildUpdateLifecycleRecord,
  type DesktopUpdateEventInput,
  UPDATE_LIFECYCLE_LOGGER_NAME,
} from "./app-otel-runtime-update.js";
import { createDesktopOtelLogEmitChannel } from "./desktop-otel-log-emit-channel.js";
import { DesktopOtelLocalBuffer } from "./local-buffer-otel-exporters.js";
import { exportRendererBridgeTraceRecordsToRelay } from "./relay-otlp-exporters.js";
import type { DesktopTelemetryTransport } from "./relay-telemetry-transport.js";
import { recordSyncBatchOutcome } from "./sync-batch-counter.js";

export const DesktopOtelRuntimeState = {
  Idle: "idle",
  Disabled: "disabled",
  Starting: "starting",
  Started: "started",
  Failed: "failed",
  Shutdown: "shutdown",
} as const;

export type DesktopOtelRuntimeState =
  (typeof DesktopOtelRuntimeState)[keyof typeof DesktopOtelRuntimeState];

export type DesktopOtelRuntime = {
  start: () => Promise<void>;
  emitAppLifecycleEvent: (input: DesktopAppLifecycleEventInput) => void;
  emitAppExceptionEvent: (input: DesktopAppExceptionEventInput) => void;
  /**
   * Emit an exception whose attributes were ALREADY sanitized, for the pre-init
   * queue in `process-exception-telemetry-bridge` (ISS-6330). That queue scrubs
   * at capture rather than at drain, so re-running the redaction pass here would
   * be a second unbounded regex sweep over the same crash text for no gain.
   *
   * `capturedAtUnixMs` is when the crash HAPPENED, which for a queued record is
   * not when it is emitted; omitting it would date every pre-init crash to the
   * moment the runtime started.
   */
  emitSanitizedAppExceptionEvent: (
    attributes: SanitizedDesktopExceptionAttributes,
    capturedAtUnixMs?: number
  ) => void;
  emitIpcPerfEvent: (input: DesktopIpcPerfEventInput) => void;
  emitSyncBatchEvent: (input: DesktopSyncBatchEventInput) => void;
  emitImportHealthEvent: (input: DesktopImportHealthEventInput) => void;
  emitOnboardingEvent: (input: DesktopOnboardingEventInput) => void;
  /**
   * ISS-12421: one onboarding analytics discard diagnostic, on this keyless
   * runtime because an ISS-12420 queue discard either has no ready target or
   * has only one belonging to a different identity than the queued event.
   */
  emitOnboardingDiscardEvent: (
    input: DesktopOnboardingDiscardEventInput
  ) => void;
  /**
   * ISS-6334: one desktop auth/pairing failure record. Deliberately on this
   * runtime rather than the authenticated telemetry POST — the relay leg here
   * is keyless, so it is the only lane that still carries a signal when auth
   * itself is what failed.
   *
   * Returns whether the record reached the SDK. Unlike its siblings this one
   * reports its own drop, because the caller de-duplicates and must not spend
   * a re-emit window on a record the runtime silently discarded.
   */
  emitAuthFailureEvent: (input: DesktopAuthFailureEventInput) => boolean;
  /**
   * ISS-7249, review cid 3821326107: REPORTS whether the record reached the
   * runtime, for the same reason `emitUpdateEvent` does. The renderer is
   * answered `{ ok }` over IPC, and a record emitted before `start()` — or after
   * a failed one — is silently dropped here; without this boolean that drop
   * would be reported to the renderer as a delivery.
   */
  emitDeadEndEvent: (input: DesktopDeadEndEventInput) => boolean;
  /**
   * ISS-7247. Like `emitDeadEndEvent` and unlike its other siblings this REPORTS
   * whether the record reached the runtime: the reconciler may only consume a
   * pending attempt once its terminal record is on the wire, so `false` means
   * the attempt survives to the next boot rather than ending silently.
   */
  emitUpdateEvent: (input: DesktopUpdateEventInput) => boolean;
  /** ISS-11347: one span per completed LLM request, for the PostHog leg. */
  emitGenAiRequestEvent: (input: DesktopGenAiRequestEventInput) => void;
  /**
   * Push everything already emitted onto the wire without shutting the runtime
   * down (ISS-6328). Production uses Batch processors with a ~5s delay, so a
   * crash handler that emits and then exits loses the exception unless it
   * awaits this first. Best-effort and never throws; the CALLER owns the time
   * cap, since a wedged relay socket must not delay a crash exit.
   */
  flush: () => Promise<void>;
  shutdown: () => Promise<void>;
  getBufferedRecords: () => DesktopOtelBufferedRecord[];
  resetBuffer: () => void;
  exportExternalRecords: (
    records: RendererOtelBridgeRecord[]
  ) => RendererOtelExportResult;
};

export type DesktopAppLifecycleEventInput = {
  event: DesktopAppLifecycleEvent;
  operatingMode: DesktopAppOperatingMode;
  /**
   * Authenticated organization id (multiplayer org attribution, FEA-1996).
   * Present only when the install is authenticated; omitted in single-player so
   * unauthenticated lifecycle telemetry never carries org identity.
   */
  organizationId?: string;
  /**
   * ISS-9082: what the Agent Monitor capture runtime reports about itself.
   * Two same-named unions exist: this one is the CONTRACT's
   * `AgentMonitorRuntimeStatusKind` from `@closedloop-ai/telemetry-contract/app`,
   * NOT the desktop's own in `shared/agent-monitor-status.ts`. Typing the field
   * with the contract's makes a desktop-side member the contract has not learned
   * a compile error here, instead of a `.strict()` parse failure that silently
   * drops the whole heartbeat in production.
   *
   * Optional and omitted when the caller cannot supply one — never defaulted to
   * `starting`, which would report an unknown runtime as a stuck one.
   */
  agentMonitorRuntimeStatus?: AgentMonitorRuntimeStatusKind;
  /**
   * ISS-11866 (R4): the relay transport's cumulative drop and sent counters.
   * Omitted — never zeroed — when the caller has no relay transport to read.
   */
  telemetryExportCounts?: DesktopTelemetryExportCounts;
};

export type DesktopAppExceptionEventInput = DesktopExceptionTelemetryInput;

/**
 * ISS-7497: the contract's `SyncOutcome`, re-exported under the name five
 * producer modules already spell. It stopped being safe to keep a second copy
 * once the outcome gained a reader on the metrics side as well as the span
 * side — a widened contract enum against a frozen desktop twin would map the
 * new member to an ERROR span with nothing red. Follows the `SyncLane` and
 * `SyncReason` precedent, which the desktop has always imported rather than
 * re-declared.
 */
export const DesktopSyncBatchOutcome = SyncOutcome;

/**
 * Transport-health outcome of a single agent-session sync batch (FEA-1995). The
 * permanent-removal class (`dead_letter`) is the oversized-session wedge the
 * sync service drops after the >256 KiB cap or repeated ack timeouts/rate
 * limits; the dashboard surfaces it instead of waiting for a user complaint.
 */
export type DesktopSyncBatchOutcome = SyncOutcome;

/**
 * Strictly transport-health (PRD-468/FEA-1981 guardrail): counts, bytes,
 * latency, outcome, and reason only — never session ids or content. `latencyMs`
 * is omitted for dead-letters dropped before any send (no round-trip occurred).
 * `reason` (FEA-3426) names why a `failure`/`dead_letter` batch failed and is
 * omitted for `success`; it is the closed `SyncReason` enum from the contract.
 */
export type DesktopSyncBatchEventInput = {
  outcome: DesktopSyncBatchOutcome;
  /**
   * ISS-6338: optional because four of the five lanes reach their outcome
   * without a measured serialized size, and a fabricated `0` would read as a
   * genuinely empty batch. Absent is absent — the attribute is omitted, never
   * sent as `null`.
   */
  payloadBytes?: number;
  latencyMs?: number;
  reason?: SyncReason;
  /**
   * ISS-6338: which of the five sync lanes produced this batch. Optional so a
   * version-skewed consumer reading records from an older desktop degrades to
   * "unattributed" rather than mis-attributing them to lane 1.
   */
  lane?: SyncLane;
  /** ISS-6338: items this lane has abandoned, carried when it just dead-lettered. */
  deadLetteredCount?: number;
  /**
   * ISS-7248: the client-generated `batchId` this attempt sent in the sync
   * request body — the only value the desktop record and the server-side span
   * can both name, and so the join key between the two halves of one failure.
   *
   * Optional because four of the five lanes have no batch id of this shape, and
   * because a record from a desktop older than ISS-7248 simply carries none;
   * absent is absent, and the attribute is omitted rather than sent as `null`.
   */
  batchId?: string;
  /** ISS-7248: sessions that rode the batch, so bytes-per-session is legible. */
  sessionCount?: number;
  /**
   * ISS-7248: 1-indexed consecutive-failure attempt for the hardest-hit row in
   * this batch, so `> 1` reads as "this is a retry". Omitted — never defaulted
   * to 1 — for the failure classes that burn no retry budget, because there is
   * genuinely no attempt count to report and a fabricated `1` would read as a
   * measured first failure.
   */
  attempt?: number;
  /** ISS-7248: how the payload was reshaped to fit the wire cap before sending. */
  payloadShaping?: SyncPayloadShaping;
  /**
   * ISS-7265: sessions in the batch that shipped WITHOUT their activity tiling.
   *
   * Carried alongside {@link payloadShaping} rather than folded into it: that
   * attribute has one slot, so a strip co-occurring with an abandoned chunk
   * sequence reports the sequence and this count becomes the span's only
   * degradation signal. Omitted when nothing was stripped, so a `0` never
   * competes with the exception it exists to surface.
   */
  tilingStrippedSessionCount?: number;
  /**
   * ISS-7496: whole milliseconds between the newest `updatedAt` among the
   * sessions the server CONFIRMED and the moment that confirmation was
   * processed — the pipeline-freshness measure behind "what is the freshest
   * session we have?".
   *
   * Set only on a confirmed delivery of a whole batch's final chunk. Omitted —
   * never zeroed — for a failure, a partial accept, a non-final chunk, or a
   * batch whose delivered rows carried no readable timestamp, because a `0`
   * here reads as "the cloud is perfectly current" and absent must keep meaning
   * unknown.
   */
  freshestSessionLagMs?: number;
};

/**
 * ISS-6338: what the SESSION lane emits. `payloadBytes` stays REQUIRED here even
 * though the shared input relaxed it, because this lane always measures its
 * serialized size and the ISS-5387 burn-down reads that number to detect re-send
 * amplification. Relaxing it for the four lanes that genuinely cannot measure one
 * must not quietly let a session-lane producer drop it — that would flatten the
 * amplification signal with nothing failing.
 */
export type SessionSyncBatchEvent = DesktopSyncBatchEventInput & {
  payloadBytes: number;
  /**
   * ISS-7401/ISS-7957: outbox rows the ack's durable delete ACTUALLY REMOVED —
   * `deleteMany`'s own `count`, not the number of ids the clear was asked
   * about. The two disagree whenever an ack names an id whose row is already
   * gone, and until ISS-7957 this field carried the ack length and therefore
   * reported progress that had not happened. `0` for a non-final chunk, which
   * spends bytes without dequeuing its session.
   *
   * Triage evidence a human reads. The cursor-stall detector acts on it only
   * together with the session lane's cursor boundary (ISS-10429). A `0` here is
   * not a failure signal: `clearOutboxOnAck` reports success for a delete that
   * matched zero rows. See
   * {@link SyncLaneBurndown.queueRowsClearedSincePrevious}.
   *
   * Declared on the SESSION event rather than the shared input on purpose: it is
   * read only by the ISS-5387 burn-down tee, so it never reaches
   * `buildSyncBatchAttributes` and adds no OTel span attribute. Omitted where a
   * producer did not measure one, which reads as unmeasured — never as "cleared
   * nothing", which would re-raise the stall alarm it exists to silence.
   */
  durablyClearedRows?: number;
};

export type CreateDesktopOtelRuntimeOptions = {
  appVersion: string;
  env: NodeJS.ProcessEnv;
  getAppInstallationId: () => string | Promise<string>;
  getDeviceId?: () => string | Promise<string>;
  getOperatingMode?: () => DesktopAppOperatingMode;
  getOrganizationId?: () => string | undefined;
  isPackaged: boolean;
  bufferLimit?: number;
  metricExportIntervalMs?: number;
  setActivityRootTimeout?: (
    callback: () => void,
    delayMs: number
  ) => DesktopActivityRootTimerHandle;
  clearActivityRootTimeout?: (handle: DesktopActivityRootTimerHandle) => void;
  /**
   * Keyless relay egress (FEA-1993). When provided, SDK signals are serialized
   * to OTLP protobuf and shipped over the relay via Batch processors instead of
   * the local buffer. When omitted, the local-buffer exporters are used (the
   * FEA-1983 behavior retained for tests/dev and the renderer bridge).
   */
  telemetryTransport?: DesktopTelemetryTransport;
};

const DEFAULT_BUFFER_LIMIT = 1000;
export const APP_LIFECYCLE_EVENT_NAME = "app.lifecycle";
export const APP_EXCEPTION_EVENT_NAME = "exception";
const SYNC_BATCH_EVENT_NAME = "sync.batch";
const APP_LIFECYCLE_LOGGER_NAME = "closedloop-desktop-app-lifecycle";
const APP_LIFECYCLE_TRACER_NAME = "closedloop-desktop-app-lifecycle";
const IPC_PERF_TRACER_NAME = "closedloop-desktop-ipc";
const IPC_PERF_SPAN_NAME_PREFIX = "ipc.";
export const DESKTOP_ACTIVITY_ROOT_MAX_AGE_MS = 5 * 60_000;
export const DESKTOP_ACTIVITY_ROOT_IDLE_TIMEOUT_MS = 30_000;
const DESKTOP_ACTIVITY_ROOT_TRACER_NAME = "closedloop-desktop-activity";
export const DESKTOP_ACTIVITY_ROOT_SPAN_NAME = "cl-desktop";
const SYNC_TRACER_NAME = "closedloop-desktop-sync";

export type DesktopActivityRootTimerHandle =
  | ReturnType<typeof setTimeout>
  | { unref?: () => void };

export function createDesktopOtelRuntime(
  options: CreateDesktopOtelRuntimeOptions
): DesktopOtelRuntime {
  const buffer = new DesktopOtelLocalBuffer(
    options.bufferLimit ?? DEFAULT_BUFFER_LIMIT
  );
  let state: DesktopOtelRuntimeState = DesktopOtelRuntimeState.Idle;
  let startPromise: Promise<void> | null = null;
  let sdk: NodeSDK | null = null;
  let resourceAttributesSnapshot: Attributes | null = null;
  const rendererTraceContexts = new Map<string, SpanContext>();
  let deviceIdSnapshot: string | undefined;
  let activityRoot: DesktopActivityRoot | null = null;
  /**
   * Drain pending SDK batches and in-flight relay sends. Null on the
   * local-buffer path, where the exporters append synchronously and there is
   * nothing to wait for.
   */
  let flushPendingSignals: (() => Promise<void>) | null = null;

  return {
    start() {
      if (
        state === DesktopOtelRuntimeState.Disabled ||
        state === DesktopOtelRuntimeState.Started ||
        state === DesktopOtelRuntimeState.Shutdown
      ) {
        return Promise.resolve();
      }
      if (startPromise) {
        return startPromise;
      }

      startPromise = startRuntime()
        .catch((error) => {
          sdk = null;
          deviceIdSnapshot = undefined;
          resourceAttributesSnapshot = null;
          flushPendingSignals = null;
          state = DesktopOtelRuntimeState.Failed;
          throw error;
        })
        .finally(() => {
          startPromise = null;
        });
      return startPromise;
    },
    emitAppLifecycleEvent(input) {
      if (state !== DesktopOtelRuntimeState.Started) {
        return;
      }

      try {
        const attributes = AppTelemetrySchema.parse({
          [TelemetryAttribute.AppLifecycleEvent]: input.event,
          [TelemetryAttribute.AppOperatingMode]: input.operatingMode,
          ...(input.organizationId
            ? { [TelemetryAttribute.AppOrganizationId]: input.organizationId }
            : {}),
          ...(input.agentMonitorRuntimeStatus
            ? {
                [TelemetryAttribute.AppAgentMonitorRuntimeStatus]:
                  input.agentMonitorRuntimeStatus,
              }
            : {}),
          ...(input.telemetryExportCounts
            ? telemetryExportCountAttributes(input.telemetryExportCounts)
            : {}),
        });
        if (input.event === DesktopAppLifecycleEvent.Heartbeat) {
          // Heartbeat is high-frequency liveness, not a useful trace child.
          createEmit(
            createDesktopOtelLogEmitChannel(APP_LIFECYCLE_LOGGER_NAME)
          )(TelemetrySchemaName.App, {
            name: APP_LIFECYCLE_EVENT_NAME,
            attributes,
          });
          return;
        }
        emitChildSpan({
          attributes,
          name: APP_LIFECYCLE_EVENT_NAME,
          tracerName: APP_LIFECYCLE_TRACER_NAME,
        });
      } catch {
        // Lifecycle telemetry is best-effort and must not affect boot/shutdown.
      }
    },
    emitAppExceptionEvent(input) {
      if (state !== DesktopOtelRuntimeState.Started) {
        return;
      }

      try {
        emitExceptionSpan(sanitizeDesktopException(input));
      } catch {
        // Exception telemetry is best-effort. It must never affect process
        // crash handling, renderer reporting, or Desktop shutdown paths.
      }
    },
    emitSanitizedAppExceptionEvent(attributes, capturedAtUnixMs) {
      if (state !== DesktopOtelRuntimeState.Started) {
        return;
      }

      try {
        emitExceptionSpan(attributes, capturedAtUnixMs);
      } catch {
        // Best-effort, exactly as emitAppExceptionEvent above.
      }
    },
    emitIpcPerfEvent(input) {
      if (state !== DesktopOtelRuntimeState.Started) {
        return;
      }

      try {
        // Validate against the closed-world ipc contract; an out-of-range value
        // (negative count, over-cap duration) throws and is swallowed below
        // rather than shipping a malformed wide event.
        const attributes = buildDesktopIpcPerfAttributes(input);
        // Wide event = one span. Span duration (end - start) is the source of
        // truth the collector tail-sampling latency policy reads; duration_ms is
        // also carried as an explicit, flat query dimension.
        emitChildSpan({
          attributes,
          durationMs: input.durationMs,
          name: `${IPC_PERF_SPAN_NAME_PREFIX}${input.operation}`,
          startTimeUnixMs: input.startTimeUnixMs,
          status: input.errorType
            ? {
                code: OTelSpanStatusCode.ERROR,
                message: input.errorType,
              }
            : undefined,
          tracerName: IPC_PERF_TRACER_NAME,
        });
      } catch {
        // IPC perf telemetry is best-effort and must never affect the handler
        // result it wraps.
      }
    },
    emitSyncBatchEvent(input) {
      if (state !== DesktopOtelRuntimeState.Started) {
        return;
      }

      // ISS-7497: count the batch on the metrics pipeline BEFORE the span, and
      // outside its try block. `tail_sampling` is trace-only, so this is the
      // only one of the two signals a sync RATE can be computed from; the span
      // below is per-batch forensics and may legitimately be dropped.
      recordSyncBatchOutcome({ outcome: input.outcome, lane: input.lane });

      try {
        // `.strict()` closed-world validation rejects any attribute outside the
        // sync.* transport-health keys plus `app.organization.id`, so a
        // regression that tried to attach session content would throw here
        // rather than leak it.
        //
        // ISS-7220: org attribution comes from the SAME helper the activity
        // root uses, so the single-player guarantee has one implementation —
        // re-deriving the multiplayer gate here is how the two would drift and
        // an unauthenticated install would start naming a tenant.
        //
        // The mode is emitted BESIDE the org, and unconditionally, because it
        // is what tells an absent org apart from an absent tenant. Read once so
        // the attribute and the gate cannot disagree within one span.
        const operatingMode = getActivityOperatingMode();
        const attributes = SyncTelemetrySchema.parse({
          ...buildSyncBatchAttributes(input),
          [TelemetryAttribute.AppOperatingMode]: operatingMode,
          ...getActivityOrganizationAttribute(operatingMode),
        });
        emitChildSpan({
          attributes,
          durationMs: input.latencyMs,
          name: SYNC_BATCH_EVENT_NAME,
          startTimeUnixMs:
            input.latencyMs === undefined
              ? undefined
              : Date.now() - input.latencyMs,
          status:
            input.outcome === DesktopSyncBatchOutcome.Success
              ? undefined
              : syncBatchErrorStatus(input.reason),
          tracerName: SYNC_TRACER_NAME,
        });
      } catch {
        // Transport-health telemetry is best-effort. A schema rejection must
        // never propagate into the sync loop's catch (where it would log a
        // misleading "sync failed" for a batch that actually succeeded) or
        // otherwise affect sync semantics. Mirrors emitAppExceptionEvent.
      }
    },
    emitImportHealthEvent(input) {
      if (state !== DesktopOtelRuntimeState.Started) {
        return;
      }

      try {
        // Log records (not spans) — these are low-frequency counters, mirroring
        // the lifecycle heartbeat's channel. The builder's `.strict()` parse is
        // what keeps anything but the import.* counts off the wire.
        createEmit(createDesktopOtelLogEmitChannel(IMPORT_HEALTH_LOGGER_NAME))(
          TelemetrySchemaName.App,
          buildImportHealthRecord(input)
        );
      } catch {
        // Import-health telemetry is best-effort per the desktop exporter
        // boundary rule: a serialization/dispatch failure must never throw
        // through this export API or affect the import pipeline it describes.
      }
    },
    emitAuthFailureEvent(input) {
      if (state !== DesktopOtelRuntimeState.Started) {
        return false;
      }

      try {
        // A log record on the same channel as the import-health counters. The
        // builder's `.strict()` parse is what keeps anything but the two closed
        // `auth.*` enums off a pipe that takes no credential to write to.
        createEmit(createDesktopOtelLogEmitChannel(AUTH_FAILURE_LOGGER_NAME))(
          TelemetrySchemaName.App,
          buildAuthFailureRecord(input)
        );
        return true;
      } catch {
        // Best-effort per the desktop exporter boundary rule: reporting that
        // auth failed must never throw into the auth path that failed.
        return false;
      }
    },
    emitOnboardingDiscardEvent(input) {
      if (state !== DesktopOtelRuntimeState.Started) {
        return;
      }

      try {
        createEmit(
          createDesktopOtelLogEmitChannel(ONBOARDING_DISCARD_LOGGER_NAME)
        )(TelemetrySchemaName.App, buildOnboardingDiscardRecord(input));
      } catch {
        // Best-effort per the desktop exporter boundary rule: a discard
        // diagnostic must never throw into the analytics queue it describes.
      }
    },
    emitOnboardingEvent(input) {
      if (state !== DesktopOtelRuntimeState.Started) {
        return;
      }

      try {
        // Log records, mirroring the import-health channel: low-frequency,
        // closed-enum counters rather than spans. No organization attribute is
        // attached — unlike the lifecycle spans, which take one from
        // `getActivityOrganizationAttribute` — because onboarding is the
        // pre-auth window and the org would identify the customer behind a
        // record whose whole point is anonymous install attribution.
        createEmit(createDesktopOtelLogEmitChannel(ONBOARDING_LOGGER_NAME))(
          TelemetrySchemaName.App,
          buildOnboardingRecord(input)
        );
      } catch {
        // Onboarding telemetry is best-effort per the desktop exporter boundary
        // rule: a serialization/dispatch failure must never throw through this
        // export API or interrupt the onboarding flow it describes.
      }
    },
    emitUpdateEvent(input) {
      if (state !== DesktopOtelRuntimeState.Started) {
        return false;
      }

      try {
        // Log records, like import-health and onboarding. The builder's
        // `.strict()` parse keeps the raw updater message — which can name a
        // user's home directory — off this keyless lane.
        createEmit(
          createDesktopOtelLogEmitChannel(UPDATE_LIFECYCLE_LOGGER_NAME)
        )(TelemetrySchemaName.App, buildUpdateLifecycleRecord(input));
        return true;
      } catch {
        // The FALSE is load-bearing, not a swallow: it keeps the attempt for the
        // next boot instead of consuming it on a record that never shipped.
        return false;
      }
    },
    emitDeadEndEvent(input) {
      if (state !== DesktopOtelRuntimeState.Started) {
        return false;
      }

      try {
        emitDeadEndRecord(
          input,
          (record) =>
            createEmit(createDesktopOtelLogEmitChannel(DEAD_END_LOGGER_NAME))(
              TelemetrySchemaName.App,
              record
            ),
          getActivityOrganizationAttribute(getActivityOperatingMode())
        );
        return true;
      } catch {
        // Same shape as `emitUpdateEvent`: never throw through this export API,
        // and report the drop rather than let the renderer read it as delivered.
        return false;
      }
    },
    emitGenAiRequestEvent(input) {
      if (state !== DesktopOtelRuntimeState.Started) {
        return;
      }
      try {
        emitGenAiRequestSpan(input);
      } catch {
        // Never thrown into the import. The bridge counts a refused request
        // (`gen_ai_request_refused`) before it reaches this call.
      }
    },
    async flush() {
      if (state !== DesktopOtelRuntimeState.Started) {
        return;
      }
      try {
        await flushPendingSignals?.();
      } catch {
        // Best-effort per the desktop exporter boundary rule: a flush failure
        // must never throw through this API or change the caller's control
        // flow — least of all a crash handler's.
      }
    },
    async shutdown() {
      if (state === DesktopOtelRuntimeState.Shutdown) {
        return;
      }
      if (startPromise) {
        try {
          await startPromise;
        } catch {
          // Startup failure is already reported by the boot caller. Shutdown
          // must remain best-effort so a rejected start does not poison quit.
        }
      }
      state = DesktopOtelRuntimeState.Shutdown;
      closeActivityRoot(Date.now());
      // Shut the SDK down first so Batch processors hand their final batches to
      // the relay exporters, THEN stop the transport. The exporters ack the SDK
      // immediately and ship fire-and-forget, so transport.stop() performs a
      // bounded drain of those in-flight sends (so the final app.lifecycle
      // shutdown event has a chance to reach the relay) before disconnecting —
      // time-capped so a degraded relay never blocks app quit.
      await sdk?.shutdown();
      await options.telemetryTransport?.stop();
      sdk = null;
      flushPendingSignals = null;
      startPromise = null;
      resourceAttributesSnapshot = null;
      rendererTraceContexts.clear();
      deviceIdSnapshot = undefined;
    },
    getBufferedRecords() {
      return buffer.snapshot();
    },
    resetBuffer() {
      buffer.reset();
      rendererTraceContexts.clear();
    },
    exportExternalRecords(records) {
      if (state === DesktopOtelRuntimeState.Disabled) {
        return {
          ok: false,
          reason: RendererOtelExportFailureReason.Disabled,
        };
      }
      // ISS-6329: a runtime that has not finished booting is a startup race,
      // not a dead sink — the renderer must be free to re-offer the record.
      // `Failed`/`Shutdown` stay `Unavailable`, which the renderer latches on.
      if (
        state === DesktopOtelRuntimeState.Idle ||
        state === DesktopOtelRuntimeState.Starting
      ) {
        return {
          ok: false,
          reason: RendererOtelExportFailureReason.NotStarted,
        };
      }
      if (
        state !== DesktopOtelRuntimeState.Started ||
        !resourceAttributesSnapshot
      ) {
        return {
          ok: false,
          reason: RendererOtelExportFailureReason.Unavailable,
        };
      }

      const droppedBefore = buffer.droppedCount();
      const identityContext = records.some(hasSpanIdentity)
        ? context.with(getActivityRootContext(Date.now()), () =>
            resolveRendererIdentityContext(
              records,
              rendererTraceContexts,
              Math.max(1, options.bufferLimit ?? DEFAULT_BUFFER_LIMIT)
            )
          )
        : null;
      const rebasedRecords = rebaseRendererRecords(records, identityContext);
      if (options.telemetryTransport) {
        exportRendererBridgeTraceRecordsToRelay({
          records: rebasedRecords,
          resourceAttributes: resourceAttributesSnapshot,
          sink: options.telemetryTransport,
        });
      }
      for (const record of rebasedRecords) {
        buffer.append({
          ...record,
          resourceAttributes: resourceAttributesSnapshot,
        });
      }
      return {
        ok: true,
        acceptedRecords: records.length,
        // Report only the evictions this call caused, not the buffer's
        // cumulative since-reset total (which also counts main-process drops).
        droppedRecordsCount: buffer.droppedCount() - droppedBefore,
      };
    },
  };

  async function startRuntime(): Promise<void> {
    if (isOtelSdkDisabled(options.env)) {
      state = DesktopOtelRuntimeState.Disabled;
      resourceAttributesSnapshot = null;
      return;
    }

    state = DesktopOtelRuntimeState.Starting;
    const started = await startDesktopOtelSdk({ buffer, options });
    sdk = started.sdk;
    deviceIdSnapshot = started.deviceId;
    resourceAttributesSnapshot = started.resourceAttributes;
    flushPendingSignals = started.flushPendingSignals;
    state = DesktopOtelRuntimeState.Started;
  }

  function getActivityRootContext(activityTimeUnixMs: number): Context {
    if (
      activityRoot &&
      activityTimeUnixMs - activityRoot.startedAtUnixMs >=
        DESKTOP_ACTIVITY_ROOT_MAX_AGE_MS
    ) {
      closeActivityRoot(activityTimeUnixMs);
    }
    if (!activityRoot) {
      activityRoot = openActivityRoot(activityTimeUnixMs);
    }
    scheduleActivityRootIdleClose();
    return trace.setSpan(context.active(), activityRoot.span);
  }

  function openActivityRoot(startTimeUnixMs: number): DesktopActivityRoot {
    const serviceVersion =
      resourceAttributesSnapshot?.[TelemetryAttribute.ServiceVersion];
    const operatingMode = getActivityOperatingMode();
    const attributes = normalizeAttributes({
      ...(typeof serviceVersion === "string"
        ? { [TelemetryAttribute.ServiceVersion]: serviceVersion }
        : {}),
      [TelemetryAttribute.AppOperatingMode]: operatingMode,
      ...(deviceIdSnapshot
        ? { [TelemetryAttribute.DeviceId]: deviceIdSnapshot }
        : {}),
      ...getActivityOrganizationAttribute(operatingMode),
    });
    const span = trace
      .getTracer(DESKTOP_ACTIVITY_ROOT_TRACER_NAME)
      .startSpan(
        DESKTOP_ACTIVITY_ROOT_SPAN_NAME,
        { startTime: startTimeUnixMs, attributes },
        ROOT_CONTEXT
      );
    return { span, startedAtUnixMs: startTimeUnixMs, idleTimer: null };
  }

  function getActivityOperatingMode(): DesktopAppOperatingMode {
    try {
      return (
        options.getOperatingMode?.() ?? DesktopAppOperatingMode.SinglePlayer
      );
    } catch {
      return DesktopAppOperatingMode.SinglePlayer;
    }
  }

  function getActivityOrganizationAttribute(
    operatingMode: DesktopAppOperatingMode
  ): Attributes {
    try {
      const organizationId = options.getOrganizationId?.();
      return organizationId &&
        operatingMode === DesktopAppOperatingMode.Multiplayer
        ? { [TelemetryAttribute.AppOrganizationId]: organizationId }
        : {};
    } catch {
      return {};
    }
  }

  function emitChildSpan({
    attributes,
    durationMs = 0,
    name,
    startTimeUnixMs = Date.now(),
    status,
    tracerName,
  }: {
    attributes: Attributes;
    durationMs?: number;
    name: string;
    startTimeUnixMs?: number;
    status?: { code: OTelSpanStatusCode; message?: string };
    tracerName: string;
  }): void {
    const span = context.with(getActivityRootContext(startTimeUnixMs), () =>
      trace.getTracer(tracerName).startSpan(
        name,
        {
          startTime: startTimeUnixMs,
          attributes: normalizeAttributes(attributes),
        },
        context.active()
      )
    );
    if (status) {
      span.setStatus(status);
    }
    span.end(startTimeUnixMs + durationMs);
  }

  function syncBatchErrorStatus(reason: SyncReason | undefined): {
    code: OTelSpanStatusCode;
    message?: string;
  } {
    return reason
      ? { code: OTelSpanStatusCode.ERROR, message: reason }
      : { code: OTelSpanStatusCode.ERROR };
  }

  function scheduleActivityRootIdleClose(): void {
    if (!activityRoot) {
      return;
    }
    clearActivityRootIdleTimer();
    activityRoot.idleTimer = (options.setActivityRootTimeout ?? setTimeout)(
      () => closeActivityRoot(Date.now()),
      DESKTOP_ACTIVITY_ROOT_IDLE_TIMEOUT_MS
    );
    activityRoot.idleTimer?.unref?.();
  }

  function clearActivityRootIdleTimer(): void {
    if (!activityRoot?.idleTimer) {
      return;
    }
    if (options.clearActivityRootTimeout) {
      options.clearActivityRootTimeout(activityRoot.idleTimer);
    } else {
      clearTimeout(activityRoot.idleTimer as ReturnType<typeof setTimeout>);
    }
    activityRoot.idleTimer = null;
  }

  function emitExceptionSpan(
    attributes: SanitizedDesktopExceptionAttributes,
    startTimeUnixMs?: number
  ): void {
    emitChildSpan({
      attributes: AppTelemetrySchema.parse({
        ...attributes,
        ...getActivityOrganizationAttribute(getActivityOperatingMode()),
      }),
      name: APP_EXCEPTION_EVENT_NAME,
      status: { code: OTelSpanStatusCode.ERROR },
      ...(startTimeUnixMs === undefined ? {} : { startTimeUnixMs }),
      tracerName: APP_LIFECYCLE_TRACER_NAME,
    });
  }

  function closeActivityRoot(endTimeUnixMs: number): void {
    if (!activityRoot) {
      return;
    }
    const span = activityRoot.span;
    clearActivityRootIdleTimer();
    activityRoot = null;
    span.end(endTimeUnixMs);
  }
}

type DesktopActivityRoot = {
  span: Span;
  startedAtUnixMs: number;
  idleTimer: DesktopActivityRootTimerHandle | null;
};
