/**
 * @file sync-lane-cloud-health.test.ts
 * @description ISS-6338 (PRD-650) — every desktop→cloud sync lane reports its
 * batch outcome to the cloud, not just lane 1.
 *
 * The assertions decode the REAL OTLP protobuf the runtime shipped to the relay
 * transport, never an in-process spy on `emitSyncBatchEvent`. That is deliberate
 * and it is the point of the ticket: the `.strict()` contract parse sits between
 * the producer and the wire, so a spy would stay green on an attribute the
 * schema silently rejects — and a rejected parse drops the WHOLE record.
 *
 * The transport these bytes reach is also the evidence for the pipe claim. It is
 * the keyless relay leg (`DesktopTelemetryTransport`), carrying no Bearer token,
 * so a lane that stopped uploading BECAUSE auth broke can still say so — unlike
 * the `sync.durable_cursor.stalled` alert, which rides the authenticated
 * `POST /desktop/telemetry` lane and dies with the thing it reports.
 */
import assert from "node:assert/strict";
import { TelemetryAttribute } from "@closedloop-ai/telemetry-contract/attributes";
import {
  SyncBatchCounterName,
  SyncLane,
  SyncReason,
} from "@closedloop-ai/telemetry-contract/sync";
import { metrics, trace } from "@opentelemetry/api";
import { logs } from "@opentelemetry/api-logs";
import {
  AGENT_COMPONENT_INVOCATION_SYNC_PROTOCOL_VERSION,
  type AgentComponentInvocationSyncAck,
  AgentComponentInvocationSyncAckState,
  AgentComponentInvocationSyncRejectReason,
} from "@repo/api/src/types/agent-component-invocation";
import { DesktopAgentComponentInvocationSyncRestErrorCode } from "@repo/api/src/types/desktop-write-lane";
import { TranscriptSkipReason } from "@repo/api/src/types/transcript-skip-reason-constants";
import { KeylessTelemetrySignal } from "@repo/shared-platform/keyless-telemetry";
import { afterEach, test } from "vitest";
import { ComponentSyncSendOutcome } from "../src/main/agent-sync/agent-component-sync-dead-letter.js";
import {
  componentInventoryBatchEvent,
  componentRecoveryBatchEvent,
  invocationPartBatchEvent,
  permanentSkipSyncReason,
  type SyncLaneBatchEvent,
  sessionMetadataBatchEvent,
  syncReasonForHttpStatus,
  transcriptArchiveBatchEvent,
} from "../src/main/agent-sync/sync-lane-cloud-health.js";
import {
  asOtlpRecordArray,
  decodeOtlpAttributes,
  walkOtlpTraceSpans,
} from "../src/main/otlp/decode-utilities.js";
import {
  getOtlpRequestType,
  OtlpExportKind,
} from "../src/main/otlp/proto-descriptor.js";
import {
  createDesktopOtelRuntime,
  type DesktopOtelRuntime,
  DesktopSyncBatchOutcome,
} from "../src/main/telemetry/app-otel-runtime.js";
import type { DesktopTelemetryTransport } from "../src/main/telemetry/relay-telemetry-transport.js";
import { SyncLaneId } from "../src/shared/sync-burndown-contract.js";
import { SPAN_PRODUCING_SYNC_LANES } from "./support/sync-lane-span-producers.js";

const SYNC_BATCH_SPAN_NAME = "sync.batch";

let activeRuntime: DesktopOtelRuntime | null = null;

afterEach(async () => {
  await activeRuntime?.shutdown();
  activeRuntime = null;
  trace.disable();
  metrics.disable();
  logs.disable();
});

type StubTransport = DesktopTelemetryTransport & {
  shipments: Array<{ signal: KeylessTelemetrySignal; body: Uint8Array }>;
};

function createStubTransport(): StubTransport {
  const shipments: Array<{
    signal: KeylessTelemetrySignal;
    body: Uint8Array;
  }> = [];
  return {
    shipments,
    start() {},
    stop() {},
    flush() {
      return Promise.resolve();
    },
    export(signal, body) {
      shipments.push({ signal, body: Uint8Array.from(body) });
      return Promise.resolve(true);
    },
  };
}

/**
 * Every `sync.batch` span the runtime actually put on the relay, as decoded
 * attribute bags. Filtered by SPAN NAME rather than by the presence of an
 * attribute, so a record that lost its lane tag still shows up here and fails a
 * lane assertion instead of vanishing from the population.
 */
function decodeRelaySyncBatchSpans(
  transport: StubTransport
): Record<string, unknown>[] {
  const traceRequestType = getOtlpRequestType(OtlpExportKind.Traces);
  const decoded: Record<string, unknown>[] = [];
  for (const shipment of transport.shipments) {
    if (shipment.signal !== KeylessTelemetrySignal.Traces) {
      continue;
    }
    const request = traceRequestType.toObject(
      traceRequestType.decode(shipment.body),
      { bytes: String, longs: String }
    ) as { resourceSpans?: unknown };
    for (const span of walkOtlpTraceSpans(
      asOtlpRecordArray(request.resourceSpans)
    )) {
      if (span.name !== SYNC_BATCH_SPAN_NAME) {
        continue;
      }
      decoded.push(decodeOtlpAttributes(asOtlpRecordArray(span.attributes)));
    }
  }
  return decoded;
}

async function startRelayRuntime(): Promise<{
  runtime: DesktopOtelRuntime;
  transport: StubTransport;
}> {
  const transport = createStubTransport();
  const runtime = createDesktopOtelRuntime({
    appVersion: "9.9.9",
    env: { CLOSEDLOOP_DEPLOYMENT_ENVIRONMENT_NAME: "desktop-prod" },
    getAppInstallationId: () => "install_sync_lane_health",
    isPackaged: false,
    telemetryTransport: transport,
  });
  activeRuntime = runtime;
  await runtime.start();
  return { runtime, transport };
}

/** Emit through the real runtime and read back what reached the relay. */
async function shipAndDecode(
  events: SyncLaneBatchEvent[]
): Promise<Record<string, unknown>[]> {
  const { runtime, transport } = await startRelayRuntime();
  for (const event of events) {
    runtime.emitSyncBatchEvent(event);
  }
  await runtime.flush();
  return decodeRelaySyncBatchSpans(transport);
}

/** The invariant part of every ack the invocation lane sees. */
const ACK_IDENTITY = {
  protocolVersion: AGENT_COMPONENT_INVOCATION_SYNC_PROTOCOL_VERSION,
  externalGenerationId: "a".repeat(64),
  partIndex: 0,
  partHash: "c".repeat(64),
} as const;

function acceptedAck(): AgentComponentInvocationSyncAck {
  return {
    ...ACK_IDENTITY,
    accepted: true,
    state: AgentComponentInvocationSyncAckState.Activated,
  };
}

function rejectedAck(
  reason: AgentComponentInvocationSyncRejectReason
): AgentComponentInvocationSyncAck {
  return { ...ACK_IDENTITY, accepted: false, reason };
}

function onlySpanForLane(
  spans: Record<string, unknown>[],
  lane: string
): Record<string, unknown> {
  const matching = spans.filter(
    (span) => span[TelemetryAttribute.SyncLane] === lane
  );
  // Throws rather than asserts: an assertion in a module-scope helper is what
  // `noStandaloneExpect` forbids, and a thrown error fails the calling test
  // identically while keeping the diagnostic.
  if (matching.length !== 1) {
    throw new Error(
      `expected exactly one ${lane} sync.batch span on the relay, got ${matching.length} (of ${spans.length} total)`
    );
  }
  return matching[0];
}

test("the contract's sync.lane set is the desktop's sync lanes plus trace_comments", () => {
  // SSOT drift guard. `SyncLane` is spelled as literals in the leaf telemetry
  // package because it cannot import the desktop's `SyncLaneId`; this test is
  // the only place that can see BOTH, so it is what keeps them from drifting.
  // ISS-11213 removed the desktop trace-comment lane; the shared contract keeps
  // its value for installed builds, so it is the one lane only the contract has.
  assert.deepEqual(
    new Set(Object.values(SyncLane)),
    new Set([...Object.values(SyncLaneId), SyncLane.TraceComments])
  );
});

test("lane 2 (invocation parts) reaches the relay tagged, with a per-reason mapping", async () => {
  const spans = await shipAndDecode([
    invocationPartBatchEvent({
      kind: "ack",
      ack: rejectedAck(AgentComponentInvocationSyncRejectReason.PartConflict),
    }),
  ]);
  const span = onlySpanForLane(spans, SyncLane.InvocationParts);
  assert.equal(
    span[TelemetryAttribute.SyncOutcome],
    DesktopSyncBatchOutcome.Failure
  );
  // `part_conflict` keeps its own spelling rather than collapsing into
  // `validation_failed` — folding them would erase the distinction the lane is
  // debugged on.
  assert.equal(span[TelemetryAttribute.SyncReason], SyncReason.PartConflict);
});

test("lane 2 reports a lane-wide unavailability as lane-wide, never as a batch rejection", async () => {
  const spans = await shipAndDecode([
    invocationPartBatchEvent({ kind: "unavailable", status: 401 }),
  ]);
  const span = onlySpanForLane(spans, SyncLane.InvocationParts);
  // Invariant 4 (`main/sync/AGENTS.md`): a lane-wide condition must never be
  // reported as attributable to the item.
  assert.equal(
    span[TelemetryAttribute.SyncReason],
    SyncReason.TransportUnavailable
  );
});

test("lane 2 reports a 404 retry as transport-unavailable, while an in-band SessionMissing reject keeps its name", () => {
  // The shared status fold reads 404 as `session_missing`, which on this lane
  // already means the route's in-band reject. A missing route must not borrow it.
  assert.equal(
    invocationPartBatchEvent({
      kind: "retry",
      error: "invocation sync returned HTTP 404",
      status: 404,
    }).reason,
    SyncReason.TransportUnavailable
  );
  assert.equal(
    invocationPartBatchEvent({
      kind: "ack",
      ack: rejectedAck(AgentComponentInvocationSyncRejectReason.SessionMissing),
    }).reason,
    SyncReason.SessionMissing
  );
});

test("ISS-11426: lane 2 names the two 403s apart, and keeps the status fold when uncoded", () => {
  // The defect: a bare 403 folded to `target_not_owned`, so an org whose
  // session-sync policy is off paged as a device holding a stale compute
  // target. Both directions are asserted, because either arm alone stays green
  // if the fold is reverted to the status.
  assert.equal(
    invocationPartBatchEvent({
      kind: "retry",
      error: "invocation sync returned HTTP 403",
      status: 403,
      forbiddenCode:
        DesktopAgentComponentInvocationSyncRestErrorCode.FeatureDisabled,
    }).reason,
    SyncReason.FeatureDisabled
  );
  assert.equal(
    invocationPartBatchEvent({
      kind: "retry",
      error: "invocation sync returned HTTP 403",
      status: 403,
      forbiddenCode:
        DesktopAgentComponentInvocationSyncRestErrorCode.TargetNotOwned,
    }).reason,
    SyncReason.TargetNotOwned
  );
  // Version skew: an API deploy predating the coded 403 sends no code, and this
  // build must keep the behaviour it shipped with rather than degrade.
  assert.equal(
    invocationPartBatchEvent({
      kind: "retry",
      error: "invocation sync returned HTTP 403",
      status: 403,
    }).reason,
    SyncReason.TargetNotOwned
  );
});

test("lane 2 success reaches the relay with no reason attribute at all", async () => {
  const spans = await shipAndDecode([
    invocationPartBatchEvent({ kind: "ack", ack: acceptedAck() }),
  ]);
  const span = onlySpanForLane(spans, SyncLane.InvocationParts);
  assert.equal(
    span[TelemetryAttribute.SyncOutcome],
    DesktopSyncBatchOutcome.Success
  );
  // Absent, not null: an optional attribute with no value is omitted from the
  // payload rather than serialized as an empty one.
  assert.ok(!(TelemetryAttribute.SyncReason in span));
});

test("ISS-11427: lane 1 (session metadata) carries the DLQ depth on its dead-letter arm", async () => {
  const spans = await shipAndDecode([
    sessionMetadataBatchEvent(
      {
        outcome: DesktopSyncBatchOutcome.DeadLetter,
        reason: SyncReason.AckOmitted,
        payloadBytes: 4096,
      },
      12
    ),
  ]);
  const span = onlySpanForLane(spans, SyncLane.SessionMetadata);
  assert.equal(
    span[TelemetryAttribute.SyncOutcome],
    DesktopSyncBatchOutcome.DeadLetter
  );
  // The gap this ticket closes: every one of the 457 dead-letter spans in the
  // 14 days to 2026-09-28 was this lane, and none of them carried a count — so
  // how many SESSIONS they stood for was unknowable from the wire.
  assert.equal(span[TelemetryAttribute.SyncDeadLetteredCount], 12);
  assert.equal(typeof span[TelemetryAttribute.SyncDeadLetteredCount], "number");
  assert.equal(span[TelemetryAttribute.SyncReason], SyncReason.AckOmitted);
});

test("ISS-11427: lane 1 does not decorate an ordinary ack_omitted failure with the standing depth", async () => {
  const spans = await shipAndDecode([
    sessionMetadataBatchEvent(
      {
        outcome: DesktopSyncBatchOutcome.Failure,
        reason: SyncReason.AckOmitted,
      },
      12
    ),
  ]);
  const span = onlySpanForLane(spans, SyncLane.SessionMetadata);
  assert.equal(
    span[TelemetryAttribute.SyncOutcome],
    DesktopSyncBatchOutcome.Failure
  );
  // Same rule as lane 3: a deferral is not an abandonment, and a standing
  // backlog reported here would read as one.
  assert.ok(!(TelemetryAttribute.SyncDeadLetteredCount in span));
});

test("ISS-11427: lane 1 omits the depth it could not read rather than shipping a zero", async () => {
  const spans = await shipAndDecode([
    sessionMetadataBatchEvent(
      {
        outcome: DesktopSyncBatchOutcome.DeadLetter,
        reason: SyncReason.AckOmitted,
      },
      undefined
    ),
  ]);
  const span = onlySpanForLane(spans, SyncLane.SessionMetadata);
  // An unmeasured depth is not a measured zero. `0` here would certify an empty
  // DLQ on the very span that says something was abandoned.
  assert.ok(!(TelemetryAttribute.SyncDeadLetteredCount in span));
});

test("ISS-11427: lane 1 floors a nonsense depth instead of shipping it", async () => {
  // Both bad values ride ONE runtime: a second `createDesktopOtelRuntime` in the
  // same test silently no-ops, because the OTel global API is already registered
  // by the first. Same constraint (and same shape) as the lane-3 case below.
  const spans = await shipAndDecode(
    [-5, Number.NaN].map((bad) =>
      sessionMetadataBatchEvent(
        {
          outcome: DesktopSyncBatchOutcome.DeadLetter,
          reason: SyncReason.AckOmitted,
        },
        bad
      )
    )
  );
  const counts = spans
    .filter(
      (span) => span[TelemetryAttribute.SyncLane] === SyncLane.SessionMetadata
    )
    .map((span) => span[TelemetryAttribute.SyncDeadLetteredCount]);
  assert.deepEqual(counts, [0, 0]);
});

test("lane 3 (component inventory) carries the dead-letter count as a NUMBER on a threshold breach", async () => {
  const spans = await shipAndDecode([
    componentInventoryBatchEvent({
      rejectedReason: SyncReason.ValidationFailed,
      deadLettered: true,
      deadLetteredCount: 7,
    }),
  ]);
  const span = onlySpanForLane(spans, SyncLane.ComponentInventory);
  assert.equal(
    span[TelemetryAttribute.SyncOutcome],
    DesktopSyncBatchOutcome.DeadLetter
  );
  // The whole point of the promotion: a structured, queryable count, not a
  // number interpolated into a sentence.
  assert.equal(span[TelemetryAttribute.SyncDeadLetteredCount], 7);
  assert.equal(typeof span[TelemetryAttribute.SyncDeadLetteredCount], "number");
});

test("lane 3 does not decorate an ordinary failure with a standing dead-letter total", async () => {
  const spans = await shipAndDecode([
    componentInventoryBatchEvent({
      rejectedReason: SyncReason.ValidationFailed,
      deadLettered: false,
      deadLetteredCount: 7,
    }),
  ]);
  const span = onlySpanForLane(spans, SyncLane.ComponentInventory);
  assert.equal(
    span[TelemetryAttribute.SyncOutcome],
    DesktopSyncBatchOutcome.Failure
  );
  // A backlog that already existed is not something this batch just abandoned.
  assert.ok(!(TelemetryAttribute.SyncDeadLetteredCount in span));
});

test("lane 4 (transcript archive) distinguishes an abandoned file from a retryable one", async () => {
  const spans = await shipAndDecode([
    transcriptArchiveBatchEvent({
      failed: true,
      dead: true,
      reason: permanentSkipSyncReason(TranscriptSkipReason.SourceGone),
    }),
  ]);
  const span = onlySpanForLane(spans, SyncLane.TranscriptArchive);
  assert.equal(
    span[TelemetryAttribute.SyncOutcome],
    DesktopSyncBatchOutcome.DeadLetter
  );
  assert.equal(span[TelemetryAttribute.SyncReason], SyncReason.SourceMissing);
});

test("lane 4 does not blame an oversized redacted line on a missing source", () => {
  // Both are `permanent: true` skips. Collapsing them would send an operator
  // hunting a transcript file that is present and readable.
  assert.equal(
    permanentSkipSyncReason(TranscriptSkipReason.TooLarge),
    SyncReason.LocallyOversized
  );
  assert.equal(
    permanentSkipSyncReason(TranscriptSkipReason.SourceGone),
    SyncReason.SourceMissing
  );
  // A producer predating the field claims nothing specific.
  assert.equal(permanentSkipSyncReason(undefined), SyncReason.TransportError);
});

test("every span-producing lane is distinguishable in one relay batch", async () => {
  const spans = await shipAndDecode([
    {
      lane: SyncLane.SessionMetadata,
      outcome: DesktopSyncBatchOutcome.Success,
    },
    invocationPartBatchEvent({ kind: "ack", ack: acceptedAck() }),
    componentInventoryBatchEvent({}),
    transcriptArchiveBatchEvent({ failed: false }),
  ]);
  assert.deepEqual(
    new Set(spans.map((span) => span[TelemetryAttribute.SyncLane])),
    new Set(SPAN_PRODUCING_SYNC_LANES)
  );
});

test("ISS-7497: a crash-path flush ships the batch COUNTS, not just the spans", async () => {
  // `runtime.flush()` is the crash-exit drain (ISS-6328): the error handlers
  // await it and then `exit(1)`, so `shutdown()` — the only other thing that
  // makes the metric reader collect — never runs. Until this was fixed, that
  // path force-flushed the span and log processors and left the metric reader
  // alone, so a crashing install shipped its sync SPANS and discarded up to a
  // full 60s export interval of `sync.batch.count`. That loss is correlated
  // with the health of the install, which is the exact bias the counter exists
  // to remove.
  const { runtime, transport } = await startRelayRuntime();
  runtime.emitSyncBatchEvent({
    lane: SyncLane.SessionMetadata,
    outcome: DesktopSyncBatchOutcome.Success,
  });
  await runtime.flush();

  const metricRequestType = getOtlpRequestType(OtlpExportKind.Metrics);
  const shippedMetricNames: string[] = [];
  for (const shipment of transport.shipments) {
    if (shipment.signal !== KeylessTelemetrySignal.Metrics) {
      continue;
    }
    const request = metricRequestType.toObject(
      metricRequestType.decode(shipment.body),
      { bytes: String, longs: String }
    ) as { resourceMetrics?: unknown };
    for (const resource of asOtlpRecordArray(request.resourceMetrics)) {
      for (const scope of asOtlpRecordArray(resource.scopeMetrics)) {
        for (const metric of asOtlpRecordArray(scope.metrics)) {
          shippedMetricNames.push(String(metric.name));
        }
      }
    }
  }
  assert.deepEqual(shippedMetricNames, [SyncBatchCounterName]);

  // Sibling in the opposite signal, so the assertion above cannot pass on a
  // transport that simply ships everything: the span for the SAME batch went
  // out on the traces pipe, which is what made the omission invisible.
  assert.equal(decodeRelaySyncBatchSpans(transport).length, 1);
});

test("ISS-7497: no lane's SUCCESS batch carries a Complete-certified attribute", async () => {
  // `sync.reason` and `sync.dead_lettered_count` are the two attributes
  // `packages/telemetry-contract/src/sync-sampling-bias.ts` certifies as
  // trustworthy, and that certification is a claim about THESE builders: it
  // holds only while the sole spans carrying them are the ones that set status
  // ERROR and are therefore retained whole by the collector. A success arm that
  // started attaching either would put it on a baseline-sampled span, and a DLQ
  // rollup would silently undercount without anything going red.
  const spans = await shipAndDecode([
    {
      lane: SyncLane.SessionMetadata,
      outcome: DesktopSyncBatchOutcome.Success,
    },
    invocationPartBatchEvent({ kind: "ack", ack: acceptedAck() }),
    componentInventoryBatchEvent({}),
    transcriptArchiveBatchEvent({ failed: false }),
    // Shipped in the SAME batch so the assertions below are the two opposite
    // states of one run, not two runs that could have diverged.
    componentInventoryBatchEvent({
      rejectedReason: SyncReason.IngestionFailed,
      deadLettered: true,
      deadLetteredCount: 4,
    }),
  ]);

  const successes = spans.filter(
    (span) =>
      span[TelemetryAttribute.SyncOutcome] === DesktopSyncBatchOutcome.Success
  );
  // Every span-producing lane reported, and every one of them succeeded.
  assert.equal(successes.length, SPAN_PRODUCING_SYNC_LANES.length);
  assert.deepEqual(
    new Set(successes.map((span) => span[TelemetryAttribute.SyncLane])),
    new Set(SPAN_PRODUCING_SYNC_LANES)
  );
  for (const span of successes) {
    assert.ok(!(TelemetryAttribute.SyncReason in span));
    assert.ok(!(TelemetryAttribute.SyncDeadLetteredCount in span));
  }

  // The same two keys in the opposite state, so neither absence above can be
  // satisfied by an attribute this build simply never emits.
  const deadLettered = spans.filter(
    (span) =>
      span[TelemetryAttribute.SyncOutcome] ===
      DesktopSyncBatchOutcome.DeadLetter
  );
  assert.equal(deadLettered.length, 1);
  assert.equal(
    deadLettered[0]?.[TelemetryAttribute.SyncReason],
    SyncReason.IngestionFailed
  );
  assert.equal(deadLettered[0]?.[TelemetryAttribute.SyncDeadLetteredCount], 4);
});

test("an unrecognised HTTP status degrades by class instead of guessing blame", () => {
  // A 5xx the build has never seen is the server failing to ingest; anything
  // else unmapped is lane-wide transport. Never a row-attributable reason, which
  // is what would dead-letter a healthy row if it were ever read as blame.
  assert.equal(syncReasonForHttpStatus(599), SyncReason.IngestionFailed);
  assert.equal(syncReasonForHttpStatus(418), SyncReason.TransportError);
  assert.equal(syncReasonForHttpStatus(undefined), SyncReason.TransportError);
  assert.equal(syncReasonForHttpStatus(429), SyncReason.RateLimited);
});

test("a nonsense dead-letter count is floored rather than shipped", async () => {
  // A negative or non-finite count means the producer is broken. The contract's
  // `.strict()` parse would REJECT THE WHOLE RECORD on either, so clamping is
  // what keeps the alert rather than losing it. Both bad values ride ONE runtime
  // — a second `createDesktopOtelRuntime` in the same test silently no-ops,
  // because the OTel global API is already registered by the first.
  const spans = await shipAndDecode(
    [-5, Number.NaN].map((bad) =>
      componentInventoryBatchEvent({
        rejectedReason: SyncReason.ValidationFailed,
        deadLettered: true,
        deadLetteredCount: bad,
      })
    )
  );
  const counts = spans
    .filter(
      (span) =>
        span[TelemetryAttribute.SyncLane] === SyncLane.ComponentInventory
    )
    .map((span) => span[TelemetryAttribute.SyncDeadLetteredCount]);
  assert.deepEqual(counts, [0, 0]);
});

test("an invocation reject reason this build has never heard of still names a cause", async () => {
  // Cross-repo skew: the `Record` is exhaustive at COMPILE time only, and the
  // reason arrives over the wire. A `failure` span with no `sync.reason` at all
  // is the outcome this fallback exists to prevent.
  const spans = await shipAndDecode([
    invocationPartBatchEvent({
      kind: "ack",
      ack: rejectedAck(
        "quota_exceeded" as AgentComponentInvocationSyncRejectReason
      ),
    }),
  ]);
  const span = onlySpanForLane(spans, SyncLane.InvocationParts);
  assert.equal(span[TelemetryAttribute.SyncReason], SyncReason.IngestionFailed);
});

test("ISS-7496: the freshest-session lag survives the strict parse and reaches the relay", async () => {
  // The `.strict()` sync schema drops the WHOLE span on an attribute it has not
  // been taught, so an in-process spy on `emitSyncBatchEvent` would stay green
  // while nothing reached the wire. Decoding the shipped protobuf is what proves
  // the contract learned the key.
  const spans = await shipAndDecode([
    {
      lane: SyncLane.SessionMetadata,
      outcome: DesktopSyncBatchOutcome.Success,
      payloadBytes: 4096,
      freshestSessionLagMs: 930_000,
    },
  ]);
  const span = onlySpanForLane(spans, SyncLane.SessionMetadata);
  assert.equal(span[TelemetryAttribute.SyncFreshestSessionLagMs], 930_000);
  assert.equal(
    typeof span[TelemetryAttribute.SyncFreshestSessionLagMs],
    "number"
  );
});

test("ISS-7496: a batch that measured no freshness ships no lag attribute at all", async () => {
  // Absent must keep meaning UNKNOWN. A `0` here would read as "the cloud is
  // perfectly current" on exactly the batches that could not be measured.
  const spans = await shipAndDecode([
    {
      lane: SyncLane.TranscriptArchive,
      outcome: DesktopSyncBatchOutcome.Success,
    },
  ]);
  const span = onlySpanForLane(spans, SyncLane.TranscriptArchive);
  assert.ok(!(TelemetryAttribute.SyncFreshestSessionLagMs in span));
});

// ---------------------------------------------------------------------------
// ISS-7985 item 3: componentRecoveryBatchEvent has zero test references.
// ---------------------------------------------------------------------------

test("ISS-7985: componentRecoveryBatchEvent Accepted → Success, no reason", () => {
  const event = componentRecoveryBatchEvent(
    ComponentSyncSendOutcome.Accepted,
    undefined
  );
  assert.equal(event.lane, SyncLane.ComponentInventory);
  assert.equal(event.outcome, DesktopSyncBatchOutcome.Success);
  assert.equal("reason" in event, false, "a success emits no reason attribute");
});

test("ISS-7985: componentRecoveryBatchEvent rejection with explicit reason", () => {
  const event = componentRecoveryBatchEvent(
    ComponentSyncSendOutcome.LaneFailure,
    SyncReason.TransportTimeout
  );
  assert.equal(event.lane, SyncLane.ComponentInventory);
  assert.equal(event.outcome, DesktopSyncBatchOutcome.Failure);
  assert.equal(event.reason, SyncReason.TransportTimeout);
});

test("ISS-7985: componentRecoveryBatchEvent rejection without reason falls back to TransportError", () => {
  const event = componentRecoveryBatchEvent(
    ComponentSyncSendOutcome.BatchRejected,
    undefined
  );
  assert.equal(event.outcome, DesktopSyncBatchOutcome.Failure);
  assert.equal(
    event.reason,
    SyncReason.TransportError,
    "absent reason degrades to transport_error, not to a specific claim"
  );
});

// ---------------------------------------------------------------------------
// ISS-7985 item 8a: permanentSkipSyncReason with a non-undefined cause absent
// from the Record (version-skew guard).
// ---------------------------------------------------------------------------

test("ISS-7985: permanentSkipSyncReason falls back for an unknown cause", () => {
  assert.equal(
    permanentSkipSyncReason("brand_new_reason" as TranscriptSkipReason),
    SyncReason.TransportError,
    "a cause from a newer producer degrades to transport_error"
  );
});

// ---------------------------------------------------------------------------
// ISS-7985 item 8b: transcriptArchiveBatchEvent reason assertion — the
// existing test asserts outcome but not the folded reason.
// ---------------------------------------------------------------------------

test("ISS-7985: transcriptArchiveBatchEvent failure without reason falls back to TransportError", () => {
  const event = transcriptArchiveBatchEvent({ failed: true });
  assert.equal(event.outcome, DesktopSyncBatchOutcome.Failure);
  assert.equal(
    event.reason,
    SyncReason.TransportError,
    "absent reason degrades to transport_error"
  );
});

test("ISS-7985: transcriptArchiveBatchEvent failure with explicit reason preserves it", () => {
  const event = transcriptArchiveBatchEvent({
    failed: true,
    reason: SyncReason.SourceMissing,
  });
  assert.equal(event.reason, SyncReason.SourceMissing);
});

// ---------------------------------------------------------------------------
// ISS-9884: the fold from a permanent skip cause onto a SyncReason decides an
// SLO bucket, and `Record<TranscriptSkipReason, SyncReason>` only forces each
// member to be PRESENT. Re-pointing one at a different SyncReason typechecks
// cleanly, so the value of every member is pinned below, and the newest one is
// pinned again through the span an operator actually reads.
// ---------------------------------------------------------------------------

const EXPECTED_PERMANENT_SKIP_SYNC_REASON: Record<
  TranscriptSkipReason,
  SyncReason
> = {
  [TranscriptSkipReason.TooLarge]: SyncReason.LocallyOversized,
  [TranscriptSkipReason.SourceGone]: SyncReason.SourceMissing,
  [TranscriptSkipReason.MaterializedSourceUnavailable]:
    SyncReason.SourceMissing,
  [TranscriptSkipReason.RetriesExhausted]: SyncReason.TransportError,
  [TranscriptSkipReason.EnvironmentUnavailable]: SyncReason.LaneGaveUp,
};

test("ISS-9884: every permanent skip cause folds to its own SyncReason", () => {
  for (const cause of Object.values(TranscriptSkipReason)) {
    assert.equal(
      permanentSkipSyncReason(cause),
      EXPECTED_PERMANENT_SKIP_SYNC_REASON[cause],
      `${cause} must fold to ${EXPECTED_PERMANENT_SKIP_SYNC_REASON[cause]}`
    );
  }
});

test("ISS-9884: lane 4 reports an environmentally-abandoned transcript as a give-up", async () => {
  const spans = await shipAndDecode([
    transcriptArchiveBatchEvent({
      failed: true,
      dead: true,
      reason: permanentSkipSyncReason(
        TranscriptSkipReason.EnvironmentUnavailable
      ),
    }),
  ]);
  const span = onlySpanForLane(spans, SyncLane.TranscriptArchive);
  assert.equal(
    span[TelemetryAttribute.SyncOutcome],
    DesktopSyncBatchOutcome.DeadLetter
  );
  assert.equal(
    span[TelemetryAttribute.SyncReason],
    SyncReason.LaneGaveUp,
    "a 24h environmental give-up must not land in the transport_error bucket"
  );
});
