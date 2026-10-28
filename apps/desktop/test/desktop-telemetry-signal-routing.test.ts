/**
 * ISS-8015 — the desktop telemetry WIRE contract.
 *
 * Five tickets shipped DONE with instrumentation that reached nothing, and every
 * one of their suites was green, because each asserted that its emitter had been
 * called. This suite asserts the other end: it drives the real runtime over the
 * real relay exporters and reads the OTLP bytes that were actually handed to the
 * transport — past `AppTelemetrySchema.parse`, past the SDK processors, past
 * `ProtobufLogsSerializer`. A `.strict()` rejection, a builder that stops
 * attaching a key, or an emitter that silently swallows its record all turn this
 * red; none of them turn a "was the emitter called" assertion red.
 *
 * It also pins each record to the index `DesktopTelemetrySignalRouting` declares.
 * That is the second half of the same defect: `sync.batch` is a span while the
 * panels asking about it queried logs, which no per-emitter test could see
 * because no per-emitter test knew there was a choice.
 */
import assert from "node:assert/strict";
import {
  AuthOutcome,
  AuthReason,
  DeadEndPhase,
  DeadEndReason,
  DeadEndRetryOutcome,
  DeadEndState,
  DeadEndTreatment,
  ImportGroupLabel,
  ImportHealthEvent,
  ImportIngestFailure,
  ImportOutcome,
  OnboardingAnalyticsDropReason,
  OnboardingConsentLevel,
  OnboardingEvent,
  OnboardingStep,
  UpdateEvent,
  UpdateFailureReason,
} from "@closedloop-ai/telemetry-contract/app";
import {
  AppBootFailureKind,
  AppBootFailureOutcome,
} from "@closedloop-ai/telemetry-contract/app-boot-failure-kind";
import { AppExceptionOrigin } from "@closedloop-ai/telemetry-contract/app-exception-origin";
import { TelemetryAttribute } from "@closedloop-ai/telemetry-contract/attributes";
import { GenAiOperationName } from "@closedloop-ai/telemetry-contract/gen-ai";
import { DeadEndRateRecordName } from "@closedloop-ai/telemetry-contract/ipc";
import { TelemetryHarnessName } from "@closedloop-ai/telemetry-contract/resource";
import {
  SyncLane,
  SyncOutcome,
  SyncPayloadShaping,
  SyncReason,
} from "@closedloop-ai/telemetry-contract/sync";
import { OnboardingAnalyticsEvent } from "@repo/api/src/types/onboarding-analytics";
import { OnboardingPhase } from "@repo/api/src/types/onboarding-phase";
import {
  type KeylessTelemetrySignal,
  KeylessTelemetrySignal as Signal,
} from "@repo/shared-platform/keyless-telemetry";
import { afterEach, test } from "vitest";
import type { DesktopOtelRuntime } from "../src/main/telemetry/app-otel-runtime.js";
import type { DesktopImportHealthEventInput } from "../src/main/telemetry/app-otel-runtime-import-health.js";
import { DesktopIpcOperation } from "../src/main/telemetry/app-otel-runtime-ipc.js";
import {
  DesktopAppLifecycleEvent,
  DesktopAppOperatingMode,
} from "../src/main/telemetry/app-otel-runtime-lifecycle.js";
import { ONBOARDING_DISCARD_EVENT_NAME } from "../src/main/telemetry/app-otel-runtime-onboarding-discard.js";
import {
  recordIpcCall,
  recordRenderedDeadEnd,
} from "../src/main/telemetry/dead-end-rate-record.js";
import { createDeadEndTelemetryRecorder } from "../src/main/telemetry/dead-end-telemetry-recorder.js";
import {
  DesktopTelemetryRecord,
  DesktopTelemetryRecordByEmitter,
  DesktopTelemetrySignalRouting,
} from "../src/main/telemetry/desktop-telemetry-signal-routing.js";
import { SourceTimeoutStage } from "../src/shared/ingest-quarantine-contract.js";
import { createTrackedRuntimeFactory } from "./app-otel-runtime-test-helpers.js";

/** A valid v4 `sync.batch_id`; the contract pattern rejects anything else. */
const BATCH_ID = "0189d4c4-1b2a-4c3d-8e4f-5a6b7c8d9e0f";

/** The emitter whose one method folds every `ImportHealthEvent` branch. */
const IMPORT_HEALTH_EMITTER = "emitImportHealthEvent";

type CapturedExport = { signal: KeylessTelemetrySignal; body: Uint8Array };

type WireCase = {
  record: DesktopTelemetryRecord;
  /** Test name when one record kind needs several cases; defaults to `record`. */
  label?: string;
  /** The log-record or span name the emitter puts on the wire. */
  wireName: string;
  emit: (runtime: DesktopOtelRuntime) => void;
  /** Attribute keys that must survive to the OTLP payload. */
  attributes: readonly string[];
};

const CASES: readonly WireCase[] = [
  {
    record: DesktopTelemetryRecord.AppLifecycleHeartbeat,
    wireName: "app.lifecycle",
    emit: (runtime) =>
      runtime.emitAppLifecycleEvent({
        event: DesktopAppLifecycleEvent.Heartbeat,
        operatingMode: DesktopAppOperatingMode.SinglePlayer,
      }),
    attributes: [
      TelemetryAttribute.AppLifecycleEvent,
      TelemetryAttribute.AppOperatingMode,
    ],
  },
  {
    // The other half of the split the routing table exists to state: the same
    // attribute family, on the other index.
    record: DesktopTelemetryRecord.AppLifecycleTransition,
    wireName: "app.lifecycle",
    emit: (runtime) =>
      runtime.emitAppLifecycleEvent({
        event: DesktopAppLifecycleEvent.Start,
        operatingMode: DesktopAppOperatingMode.Multiplayer,
        organizationId: "org_0123456789abcdef",
      }),
    attributes: [
      TelemetryAttribute.AppLifecycleEvent,
      TelemetryAttribute.AppOperatingMode,
      TelemetryAttribute.AppOrganizationId,
    ],
  },
  {
    record: DesktopTelemetryRecord.AppException,
    label: "app.exception (sanitized at emit)",
    wireName: "exception",
    emit: (runtime) =>
      runtime.emitAppExceptionEvent({
        error: new TypeError("probe"),
        origin: AppExceptionOrigin.Main,
        // ISS-8907: the boot path is the only producer that sets a kind, and
        // this is the emitter it uses. A value outside the closed set cannot
        // reach the key check below either — `AppTelemetrySchema` is `.strict()`
        // and its `z.enum` rejection drops the whole record, not the attribute.
        bootFailureKind: AppBootFailureKind.ModuleResolution,
        // ISS-9259: the second axis rides the same emitter, so it needs the same
        // wire proof — `AppTelemetrySchema` is `.strict()`, and an attribute the
        // boundary schema does not know drops the whole record rather than the
        // field.
        bootFailureOutcome: AppBootFailureOutcome.Failed,
      }),
    attributes: [
      TelemetryAttribute.ExceptionType,
      TelemetryAttribute.AppExceptionOrigin,
      TelemetryAttribute.AppBootFailureKind,
      TelemetryAttribute.AppBootFailureOutcome,
    ],
  },
  {
    // whitlockk review: this emitter shares its record kind with the one above, so
    // record-level coverage left it undriven — a regression confined to the
    // pre-init guard on THIS method stayed green. It is a distinct path: the
    // caller sanitized at capture (the process bridge, which runs before the
    // runtime starts), so nothing re-sanitizes here.
    record: DesktopTelemetryRecord.AppException,
    label: "app.exception (sanitized at capture)",
    wireName: "exception",
    emit: (runtime) =>
      runtime.emitSanitizedAppExceptionEvent({
        [TelemetryAttribute.ExceptionType]: "TypeError",
        [TelemetryAttribute.AppExceptionOrigin]: AppExceptionOrigin.Main,
      }),
    attributes: [
      TelemetryAttribute.ExceptionType,
      TelemetryAttribute.AppExceptionOrigin,
    ],
  },
  {
    record: DesktopTelemetryRecord.IpcPerf,
    wireName: "ipc.list",
    emit: (runtime) =>
      runtime.emitIpcPerfEvent({
        operation: "list",
        startTimeUnixMs: Date.now() - 10,
        durationMs: 10,
        payloadBytes: 1,
        resultCount: 1,
        sessionCount: 1,
      }),
    attributes: [
      TelemetryAttribute.IpcOperation,
      TelemetryAttribute.IpcResultCount,
      TelemetryAttribute.IpcPayloadBytes,
      TelemetryAttribute.IpcSessionCount,
    ],
  },
  {
    // Written by `instrumentIpcPerf` through the global logger, not by a
    // runtime method, so this case ignores the runtime it is handed.
    record: DesktopTelemetryRecord.DeadEndRate,
    label: "dead_end.rate (IPC call)",
    wireName: DeadEndRateRecordName,
    emit: () => recordIpcCall(DesktopIpcOperation.List),
    attributes: [TelemetryAttribute.IpcOperation],
  },
  {
    // Direct, because through the runtime the `dead_end.treatment` record in
    // the same export carries `dead_end.phase` too and would satisfy the check.
    record: DesktopTelemetryRecord.DeadEndRate,
    label: "dead_end.rate (dead end)",
    wireName: DeadEndRateRecordName,
    emit: () => recordRenderedDeadEnd(),
    attributes: [TelemetryAttribute.DeadEndPhase],
  },
  {
    // The production path: the dead-end recorder writes the rate record ahead
    // of its cap, not the runtime's `emitDeadEndEvent`.
    record: DesktopTelemetryRecord.DeadEndRate,
    label: "dead_end.rate (from the dead-end recorder)",
    wireName: DeadEndRateRecordName,
    emit: () =>
      createDeadEndTelemetryRecorder({ emit: () => false }).record({
        treatment: DeadEndTreatment.SessionDetailNotFound,
        phase: DeadEndPhase.Rendered,
        state: DeadEndState.TrueZero,
        reason: DeadEndReason.Absent,
        retryOffered: false,
        retryAttempt: 0,
      }),
    attributes: [],
  },
  {
    // ISS-6338 / ISS-7220 / ISS-7248: every attribute below rides this ONE
    // span, so a `.strict()` rejection takes all five of them at once.
    record: DesktopTelemetryRecord.SyncBatch,
    wireName: "sync.batch",
    emit: (runtime) =>
      runtime.emitSyncBatchEvent({
        outcome: SyncOutcome.Failure,
        lane: SyncLane.InvocationParts,
        reason: SyncReason.TransportError,
        attempt: 2,
        payloadShaping: SyncPayloadShaping.ChunkedHead,
        deadLetteredCount: 3,
        batchId: BATCH_ID,
        sessionCount: 4,
        payloadBytes: 100,
        latencyMs: 50,
      }),
    attributes: [
      TelemetryAttribute.SyncOutcome,
      TelemetryAttribute.SyncLane,
      TelemetryAttribute.SyncReason,
      TelemetryAttribute.SyncAttempt,
      TelemetryAttribute.SyncPayloadShaping,
      TelemetryAttribute.SyncDeadLetteredCount,
    ],
  },
  {
    // One case per `ImportHealthEvent` branch: `buildImportHealthRecord` is an
    // eight-way fold and only the branch a case drives can lose an attribute
    // detectably. "Every ImportHealthEvent branch has a wire case" below is
    // what keeps that one-per-branch claim true as the fold grows.
    record: DesktopTelemetryRecord.ImportHealth,
    label: "import.health (pass)",
    wireName: "import.health",
    emit: (runtime) =>
      runtime.emitImportHealthEvent({
        kind: ImportHealthEvent.Pass,
        outcome: ImportOutcome.Imported,
        sessionsIncomplete: 0,
        sessionsPendingRevision: 0,
        quarantinedByStage: {
          [SourceTimeoutStage.Parse]: 0,
          [SourceTimeoutStage.Import]: 0,
        },
      }),
    attributes: [
      TelemetryAttribute.ImportEvent,
      TelemetryAttribute.ImportOutcome,
      TelemetryAttribute.ImportSessionsIncomplete,
      TelemetryAttribute.ImportSessionsPendingRevision,
      TelemetryAttribute.ImportSourcesQuarantinedParse,
      TelemetryAttribute.ImportSourcesQuarantinedImport,
    ],
  },
  {
    record: DesktopTelemetryRecord.ImportHealth,
    label: "import.group_failed",
    wireName: "import.group_failed",
    emit: (runtime) =>
      runtime.emitImportHealthEvent({
        kind: ImportHealthEvent.GroupFailed,
        groupLabel: ImportGroupLabel.Events,
        count: 2,
      }),
    attributes: [
      TelemetryAttribute.ImportEvent,
      TelemetryAttribute.ImportGroupLabel,
      TelemetryAttribute.ImportGroupFailedCount,
    ],
  },
  {
    record: DesktopTelemetryRecord.ImportHealth,
    label: "import.ingest_failed",
    wireName: "import.ingest_failed",
    emit: (runtime) =>
      runtime.emitImportHealthEvent({
        kind: ImportHealthEvent.IngestFailed,
        reason: ImportIngestFailure.SourceParseThrew,
        count: 3,
      }),
    attributes: [
      TelemetryAttribute.ImportEvent,
      TelemetryAttribute.ImportIngestFailure,
      TelemetryAttribute.ImportIngestFailedCount,
    ],
  },
  {
    record: DesktopTelemetryRecord.ImportHealth,
    label: "import.sources_remaining",
    wireName: "import.sources_remaining",
    emit: (runtime) =>
      runtime.emitImportHealthEvent({
        kind: ImportHealthEvent.SourcesRemaining,
        harness: TelemetryHarnessName.Claude,
        sourcesRemaining: 5,
      }),
    attributes: [
      TelemetryAttribute.ImportEvent,
      TelemetryAttribute.HarnessName,
      TelemetryAttribute.ImportSourcesRemaining,
    ],
  },
  {
    record: DesktopTelemetryRecord.ImportHealth,
    label: "import.harness_not_advancing",
    wireName: "import.harness_not_advancing",
    emit: (runtime) =>
      runtime.emitImportHealthEvent({
        kind: ImportHealthEvent.HarnessNotAdvancing,
        harness: TelemetryHarnessName.Codex,
        sourcesRemaining: 1,
      }),
    attributes: [
      TelemetryAttribute.ImportEvent,
      TelemetryAttribute.HarnessName,
      TelemetryAttribute.ImportSourcesRemaining,
    ],
  },
  {
    // ISS-8600. The three occurrence branches carry no count of their own, so
    // `harness.name` is the whole dimension a monitor groups by and losing it
    // would leave three records nobody can attribute to a harness.
    record: DesktopTelemetryRecord.ImportHealth,
    label: "import.watch_lost",
    wireName: "import.watch_lost",
    emit: (runtime) =>
      runtime.emitImportHealthEvent({
        kind: ImportHealthEvent.WatchLost,
        harness: TelemetryHarnessName.Copilot,
      }),
    attributes: [
      TelemetryAttribute.ImportEvent,
      TelemetryAttribute.HarnessName,
    ],
  },
  {
    record: DesktopTelemetryRecord.ImportHealth,
    label: "import.materialize_failed",
    wireName: "import.materialize_failed",
    emit: (runtime) =>
      runtime.emitImportHealthEvent({
        kind: ImportHealthEvent.MaterializeFailed,
        harness: TelemetryHarnessName.OpenCode,
      }),
    attributes: [
      TelemetryAttribute.ImportEvent,
      TelemetryAttribute.HarnessName,
    ],
  },
  {
    record: DesktopTelemetryRecord.ImportHealth,
    label: "import.materialize_timed_out",
    wireName: "import.materialize_timed_out",
    emit: (runtime) =>
      runtime.emitImportHealthEvent({
        kind: ImportHealthEvent.MaterializeTimedOut,
        harness: TelemetryHarnessName.OpenCode,
      }),
    attributes: [
      TelemetryAttribute.ImportEvent,
      TelemetryAttribute.HarnessName,
    ],
  },
  {
    record: DesktopTelemetryRecord.Onboarding,
    wireName: "onboarding.lifecycle",
    emit: (runtime) =>
      runtime.emitOnboardingEvent({
        step: OnboardingStep.Auth,
        event: OnboardingEvent.ConsentRecorded,
        consentLevel: OnboardingConsentLevel.Full,
      }),
    attributes: [
      TelemetryAttribute.OnboardingEvent,
      TelemetryAttribute.OnboardingStep,
      TelemetryAttribute.OnboardingConsentLevel,
    ],
  },
  {
    // ISS-12421: rides the de-identified request like the auth failure below.
    record: DesktopTelemetryRecord.OnboardingDiscard,
    wireName: ONBOARDING_DISCARD_EVENT_NAME,
    emit: (runtime) =>
      runtime.emitOnboardingDiscardEvent({
        reason: OnboardingAnalyticsDropReason.UserSignedOut,
        originalEvent: OnboardingAnalyticsEvent.StepViewed,
        step: OnboardingPhase.SyncPolicy,
        flowId: "90069504-7d38-4678-9e99-88637ed9333a",
        queueAgeMs: 2000,
      }),
    attributes: [
      TelemetryAttribute.OnboardingAnalyticsAction,
      TelemetryAttribute.OnboardingAnalyticsReason,
      TelemetryAttribute.OnboardingAnalyticsOriginalEvent,
      TelemetryAttribute.OnboardingAnalyticsStep,
      TelemetryAttribute.OnboardingAnalyticsFlowId,
      TelemetryAttribute.DurationMs,
    ],
  },
  {
    // ISS-7247 plus ISS-7225's `update.current_version_age_days`.
    record: DesktopTelemetryRecord.UpdateLifecycle,
    wireName: "update.lifecycle",
    emit: (runtime) =>
      runtime.emitUpdateEvent({
        event: UpdateEvent.DownloadFailed,
        fromVersion: "1.0.0",
        toVersion: "1.1.0",
        failureReason: UpdateFailureReason.DownloadError,
        bootAttempts: 1,
        currentVersionAgeDays: 4,
      }),
    attributes: [
      TelemetryAttribute.UpdateEvent,
      TelemetryAttribute.UpdateFailureReason,
      TelemetryAttribute.UpdateBootAttempts,
      TelemetryAttribute.UpdateCurrentVersionAgeDays,
      TelemetryAttribute.UpdateFromVersion,
      TelemetryAttribute.UpdateToVersion,
    ],
  },
  {
    record: DesktopTelemetryRecord.DeadEnd,
    wireName: "dead_end.treatment",
    emit: (runtime) =>
      runtime.emitDeadEndEvent({
        treatment: DeadEndTreatment.SessionsListStalled,
        phase: DeadEndPhase.RetrySettled,
        state: DeadEndState.Unavailable,
        reason: DeadEndReason.FetchFailed,
        retryOffered: true,
        retryAttempt: 1,
        retryOutcome: DeadEndRetryOutcome.StillDeadEnd,
      }),
    attributes: [
      TelemetryAttribute.DeadEndTreatment,
      TelemetryAttribute.DeadEndPhase,
      TelemetryAttribute.DeadEndState,
      TelemetryAttribute.DeadEndReason,
      TelemetryAttribute.DeadEndRetryOutcome,
      TelemetryAttribute.DeadEndRetryOffered,
      TelemetryAttribute.DeadEndRetryAttempt,
    ],
  },
  {
    // Ships under a de-identified Resource in its OWN request, which is still a
    // `logs` export — the split is by resource identity, not by signal.
    record: DesktopTelemetryRecord.AuthFailure,
    wireName: "auth.failure",
    emit: (runtime) =>
      runtime.emitAuthFailureEvent({
        outcome: AuthOutcome.TokenRejected,
        reason: AuthReason.RelayRejectedCredential,
      }),
    attributes: [TelemetryAttribute.AuthOutcome, TelemetryAttribute.AuthReason],
  },
  {
    // ISS-11347: the span the collector's PostHog leg routes on. Every key
    // below rides one `.strict()` parse, so a rejection takes all of them.
    record: DesktopTelemetryRecord.GenAiRequest,
    wireName: GenAiOperationName.Chat,
    emit: (runtime) =>
      runtime.emitGenAiRequestEvent({
        model: "claude-sonnet-4-5",
        inputTokens: 10,
        outputTokens: 20,
        cacheReadInputTokens: 30,
        cacheCreationInputTokens: 40,
        costUsd: 0.01,
        atUnixMs: Date.now(),
      }),
    attributes: [
      TelemetryAttribute.GenAiOperationName,
      TelemetryAttribute.GenAiRequestModel,
      TelemetryAttribute.GenAiUsageInputTokens,
      TelemetryAttribute.GenAiUsageOutputTokens,
      TelemetryAttribute.GenAiUsageCacheReadInputTokens,
      TelemetryAttribute.GenAiUsageCacheCreationInputTokens,
      TelemetryAttribute.GenAiCostUsage,
    ],
  },
];

const { createTestRuntime, resetTrackedRuntime } =
  createTrackedRuntimeFactory();

// The shared teardown, not a local shutdown: it also clears the OTel global
// providers, without which the SECOND runtime in this file emits into the first
// one's shut-down pipeline and every case after the first reports nothing.
afterEach(resetTrackedRuntime);

/** A started runtime whose relay exports land in `captured`. */
async function startCapturingRuntime(
  captured: CapturedExport[]
): Promise<DesktopOtelRuntime> {
  const runtime = createTestRuntime({
    appVersion: "1.2.3",
    isPackaged: true,
    // Long enough that the periodic reader never fires on its own; the only
    // metric export is the one `flush()` forces.
    metricExportIntervalMs: 600_000,
    telemetryTransport: {
      start() {
        // The keyless handshake is the transport's business, not this suite's.
      },
      stop() {
        // Teardown runs through `resetTrackedRuntime`.
      },
      flush: () => Promise.resolve(),
      export: (signal, body) => {
        captured.push({ signal, body });
        return Promise.resolve(true);
      },
    },
  });
  await runtime.start();
  return runtime;
}

for (const wireCase of CASES) {
  test(`${wireCase.label ?? wireCase.record} reaches the OTLP wire on its declared signal`, async () => {
    const captured: CapturedExport[] = [];
    const runtime = await startCapturingRuntime(captured);

    wireCase.emit(runtime);
    await runtime.flush();

    const expectedSignal = DesktopTelemetrySignalRouting[wireCase.record];
    // Scoped to the declared signal on purpose: `sync.batch.count` carries
    // `sync.lane` and `sync.outcome` on the METRICS export, so a search across
    // every body would report the span's attributes present after the span
    // itself had been dropped whole.
    const payloads = captured
      .filter((entry) => entry.signal === expectedSignal)
      .map((entry) => Buffer.from(entry.body));
    assert.ok(
      payloads.length > 0,
      `${wireCase.record} produced no ${expectedSignal} export; signals seen: ${
        captured.map((entry) => entry.signal).join(", ") || "none"
      }`
    );

    const carrier = payloads.find((payload) =>
      payload.includes(wireCase.wireName)
    );
    assert.ok(
      carrier,
      `no ${expectedSignal} export carried "${wireCase.wireName}"`
    );
    for (const attribute of wireCase.attributes) {
      // COUNT, not `includes`. `dead_end.treatment` is both the record name and
      // an attribute key, so a presence check on it passes on the name alone —
      // verified by deleting the attribute from `buildDeadEndRecord`, which left
      // this suite green until the count went in.
      const namesakeOccurrences = attribute === wireCase.wireName ? 1 : 0;
      assert.ok(
        countOccurrences(carrier, attribute) > namesakeOccurrences,
        `"${attribute}" never reached the ${expectedSignal} payload for ${wireCase.record}`
      );
    }
  });
}

/** Non-overlapping occurrences of `needle`'s UTF-8 bytes in `payload`. */
function countOccurrences(payload: Buffer, needle: string): number {
  let count = 0;
  let from = 0;
  let at = payload.indexOf(needle, from);
  while (at !== -1) {
    count += 1;
    from = at + needle.length;
    at = payload.indexOf(needle, from);
  }
  return count;
}

test("every declared record kind has a wire case", () => {
  // Without this, adding a record kind to the routing table costs nothing and
  // the new record's attributes go unproven — the shape that let five families
  // ship unverified in the first place.
  const covered = new Set(CASES.map((wireCase) => wireCase.record));
  covered.add(DesktopTelemetryRecord.SyncBatchCount);
  const uncovered = Object.values(DesktopTelemetryRecord).filter(
    (record) => !covered.has(record)
  );

  assert.deepEqual(uncovered, []);
});

test("every emitter method has a wire case", () => {
  // whitlockk review: the check above is per RECORD KIND, and two emitters share
  // `AppException`, so one case satisfied both and left the other undriven.
  // Which emitter a case drives is OBSERVED rather than annotated — each case's
  // `emit` runs against a recording stand-in — so a case cannot claim an
  // emitter it does not call, and a new case needs no bookkeeping.
  const driven = new Set<string>();
  const recorder = new Proxy(
    {},
    {
      get: (_target, property) => {
        if (typeof property === "string") {
          driven.add(property);
        }
        return () => undefined;
      },
    }
  ) as DesktopOtelRuntime;

  for (const wireCase of CASES) {
    wireCase.emit(recorder);
  }

  const uncovered = Object.keys(DesktopTelemetryRecordByEmitter).filter(
    (emitter) => !driven.has(emitter)
  );

  assert.deepEqual(uncovered, []);
});

test("every ImportHealthEvent branch has a wire case", () => {
  // ISS-8600 review: the two guards above are per RECORD KIND and per EMITTER,
  // and ONE of each covers every `import.event` branch -- so three branches
  // were added to the fold with both guards still green and no case driving
  // them. This is the same guard at the granularity that can see them.
  //
  // Which branch a case drives is OBSERVED, not annotated: a case cannot claim
  // a branch it does not emit, and a new case needs no bookkeeping.
  const driven = new Set<string>();
  const recorder = new Proxy(
    {},
    {
      get: (_target, property) =>
        property === IMPORT_HEALTH_EMITTER
          ? (input: DesktopImportHealthEventInput) => {
              driven.add(input.kind);
            }
          : () => undefined,
    }
  ) as DesktopOtelRuntime;

  for (const wireCase of CASES) {
    wireCase.emit(recorder);
  }

  const uncovered = Object.values(ImportHealthEvent).filter(
    (kind) => !driven.has(kind)
  );

  assert.deepEqual(uncovered, []);
});

test("sync.batch.count reaches the metrics index even when the span does not", async () => {
  const captured: CapturedExport[] = [];
  const runtime = await startCapturingRuntime(captured);

  // A batch id the contract's UUID pattern rejects: `SyncTelemetrySchema` is
  // `.strict()`, so the whole span is dropped. ISS-7497 put the counter ahead of
  // that parse for exactly this case, and this is what proves it stayed there.
  runtime.emitSyncBatchEvent({
    outcome: SyncOutcome.Failure,
    lane: SyncLane.SessionMetadata,
    batchId: "not-a-uuid",
  });
  await runtime.flush();

  assert.equal(
    captured.some((entry) => entry.signal === Signal.Traces),
    false,
    "a rejected sync.batch must not reach the traces index"
  );
  const metrics = captured
    .filter((entry) => entry.signal === Signal.Metrics)
    .map((entry) => Buffer.from(entry.body));
  assert.ok(
    metrics.some((payload) => payload.includes(TelemetryAttribute.SyncLane)),
    "sync.batch.count lost its lane when the span was rejected"
  );
});
