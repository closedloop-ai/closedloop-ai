/**
 * ISS-7220 — the `sync.batch` child-span half of the desktop OTel runtime,
 * split out of `app-otel-runtime.test.ts`.
 *
 * Its own file because the parent suite is on the shrink-only
 * `noExcessiveLinesPerFile` grandfather list in `biome.jsonc`, and because
 * `sync.batch` emission is a self-contained responsibility: it is the only
 * runtime surface that validates against `SyncTelemetrySchema` rather than the
 * App one, and the only one whose `.strict()` rejection drops a whole span.
 */
import assert from "node:assert/strict";
import { TelemetryAttribute } from "@closedloop-ai/telemetry-contract/attributes";
import { SpanStatusCode } from "@closedloop-ai/telemetry-contract/span";
import {
  SyncBatchCounterName,
  SyncLane,
} from "@closedloop-ai/telemetry-contract/sync";
import { afterEach, test } from "vitest";
import { DesktopSyncBatchOutcome } from "../src/main/telemetry/app-otel-runtime.js";
import { DesktopAppOperatingMode } from "../src/main/telemetry/app-otel-runtime-lifecycle.js";
import { DesktopOtelSignal } from "../src/shared/renderer-otel-bridge-constants.js";
import {
  collectResourceAttributeMismatches,
  createTrackedRuntimeFactory,
} from "./app-otel-runtime-test-helpers.js";

const { createTestRuntime, resetTrackedRuntime } =
  createTrackedRuntimeFactory();

afterEach(resetTrackedRuntime);

test("emits sync.batch records as child spans", async () => {
  const runtime = createTestRuntime({
    appVersion: "1.2.3",
    env: {
      CLOSEDLOOP_DEPLOYMENT_ENVIRONMENT_NAME: "desktop-prod",
    },
    getAppInstallationId: () => "install_0123456789abcdef",
  });
  await runtime.start();

  runtime.emitSyncBatchEvent({
    outcome: DesktopSyncBatchOutcome.Success,
    payloadBytes: 2048,
    latencyMs: 37,
  });
  runtime.emitSyncBatchEvent({
    outcome: DesktopSyncBatchOutcome.Failure,
    payloadBytes: 512,
    latencyMs: 9,
    reason: "ack_timeout",
  });
  // dead-lettered before any send → no latency to report.
  runtime.emitSyncBatchEvent({
    outcome: DesktopSyncBatchOutcome.DeadLetter,
    payloadBytes: 300_000,
    reason: "locally_oversized",
  });
  await runtime.shutdown();

  const syncRecords = runtime
    .getBufferedRecords()
    .filter(
      (record) =>
        record.signal === DesktopOtelSignal.Trace &&
        record.name === "sync.batch"
    );

  assert.equal(syncRecords.length, 3);
  for (const record of syncRecords) {
    assert.equal(record.attributes?.[TelemetryAttribute.SyncEvent], "batch");
    assert.equal(record.instrumentationScope?.name, "closedloop-desktop-sync");
    assert.deepEqual(
      collectResourceAttributeMismatches(record.resourceAttributes),
      []
    );
  }
  assert.deepEqual(
    syncRecords.map(
      (record) => record.attributes?.[TelemetryAttribute.SyncOutcome]
    ),
    [
      DesktopSyncBatchOutcome.Success,
      DesktopSyncBatchOutcome.Failure,
      DesktopSyncBatchOutcome.DeadLetter,
    ]
  );
  assert.deepEqual(
    syncRecords.map(
      (record) => record.attributes?.[TelemetryAttribute.SyncPayloadBytes]
    ),
    [2048, 512, 300_000]
  );
  assert.deepEqual(
    syncRecords.map(
      (record) => record.attributes?.[TelemetryAttribute.SyncLatencyMs]
    ),
    [37, 9, undefined]
  );
  // FEA-3426: `reason` maps to sync.reason on failure/dead_letter, and is
  // OMITTED (not null/empty) on success — the guard against a producer that
  // emits a reason the runtime silently drops.
  assert.deepEqual(
    syncRecords.map(
      (record) => record.attributes?.[TelemetryAttribute.SyncReason]
    ),
    [undefined, "ack_timeout", "locally_oversized"]
  );
  assert.deepEqual(
    syncRecords.map((record) => record.status?.code),
    [SpanStatusCode.Unset, SpanStatusCode.Error, SpanStatusCode.Error]
  );
  assert.deepEqual(
    syncRecords.map((record) => record.status?.message),
    [undefined, "ack_timeout", "locally_oversized"]
  );
});

test("a dead-lettered sync batch names its lane AND its org in multiplayer, and an unattributed batch stays distinguishable from a single-player one (ISS-7220)", async () => {
  const organizationId = "0190f6a1-5b2c-7d3e-8f40-6a7b8c9d0e1f";
  let operatingMode: DesktopAppOperatingMode =
    DesktopAppOperatingMode.Multiplayer;
  let resolvedOrganizationId: string | undefined = organizationId;
  const runtime = createTestRuntime({
    appVersion: "1.2.3",
    getAppInstallationId: () => "install_0123456789abcdef",
    getOperatingMode: () => operatingMode,
    getOrganizationId: () => resolvedOrganizationId,
  });
  await runtime.start();

  const deadLetteredBatch = {
    outcome: DesktopSyncBatchOutcome.DeadLetter,
    lane: SyncLane.ComponentInventory,
    deadLetteredCount: 7,
    payloadBytes: 4096,
    reason: "ingestion_failed",
  } as const;

  runtime.emitSyncBatchEvent(deadLetteredBatch);
  // Multiplayer, but `GET /me` has not resolved yet — the batch is this
  // tenant's and cannot say so. It must NOT be mistaken for single-player.
  resolvedOrganizationId = undefined;
  runtime.emitSyncBatchEvent(deadLetteredBatch);
  // Single-player: a resolver that DOES have an org, so the omission is proved
  // by the operating-mode gate rather than by an empty resolver.
  operatingMode = DesktopAppOperatingMode.SinglePlayer;
  resolvedOrganizationId = organizationId;
  runtime.emitSyncBatchEvent(deadLetteredBatch);
  await runtime.shutdown();

  const syncRecords = runtime
    .getBufferedRecords()
    .filter(
      (record) =>
        record.signal === DesktopOtelSignal.Trace &&
        record.name === "sync.batch"
    );

  // Count first: `.strict()` rejects the WHOLE bag, and emitSyncBatchEvent
  // swallows that rejection, so an attribute the schema does not admit drops
  // the entire span rather than just the key. Without this the surviving
  // records shift up a slot and the failure reads as a missing attribute
  // instead of a lost batch.
  assert.equal(syncRecords.length, 3);
  const [attributed, unresolved, singlePlayer] = syncRecords;

  const deadLetterBag = {
    "sync.event": "batch",
    "sync.outcome": "dead_letter",
    "sync.payload_bytes": 4096,
    "sync.reason": "ingestion_failed",
    "sync.lane": "component_inventory",
    "sync.dead_lettered_count": 7,
  };

  // Whole-bag equality, not key-by-key: a regression that dropped the lane or
  // the count while keeping the org would still satisfy per-key assertions.
  assert.deepEqual(attributed?.attributes, {
    ...deadLetterBag,
    "app.operating_mode": "multiplayer",
    "app.organization.id": organizationId,
  });
  // The whole point of carrying the mode: this bag and the next one both omit
  // the org, and they are NOT equal.
  assert.deepEqual(unresolved?.attributes, {
    ...deadLetterBag,
    "app.operating_mode": "multiplayer",
  });
  assert.deepEqual(singlePlayer?.attributes, {
    ...deadLetterBag,
    "app.operating_mode": "single_player",
  });
  assert.notDeepEqual(unresolved?.attributes, singlePlayer?.attributes);
});

test("counts every sync batch on the metrics pipeline, including the successes whose spans tail sampling drops (ISS-7497)", async () => {
  const runtime = createTestRuntime({
    appVersion: "1.2.3",
    getAppInstallationId: () => "install_0123456789abcdef",
  });
  await runtime.start();

  // Deliberately ASYMMETRIC: three successes to one failure. A span-only
  // pipeline can promise the 1 (status ERROR keeps its trace whole) and cannot
  // promise the 3, so a fixture with equal arms would pass either way.
  for (let index = 0; index < 3; index += 1) {
    runtime.emitSyncBatchEvent({
      outcome: DesktopSyncBatchOutcome.Success,
      lane: SyncLane.SessionMetadata,
      payloadBytes: 1024,
      latencyMs: 12,
    });
  }
  runtime.emitSyncBatchEvent({
    outcome: DesktopSyncBatchOutcome.Failure,
    lane: SyncLane.SessionMetadata,
    payloadBytes: 512,
    latencyMs: 9,
    reason: "ack_timeout",
  });
  await runtime.shutdown();

  const records = runtime.getBufferedRecords();
  const counts = records.filter(
    (record) =>
      record.signal === DesktopOtelSignal.Metric &&
      record.name === SyncBatchCounterName
  );

  // The counter is on the METRIC signal, not the trace signal. That is the
  // whole fix: `tail_sampling` is trace-only, so no keep/drop decision stands
  // between a batch and its increment.
  assert.equal(counts.length, 2);
  const byOutcome = new Map(
    counts.map((record) => [
      record.attributes?.[TelemetryAttribute.SyncOutcome],
      record,
    ])
  );
  assert.equal(byOutcome.get(DesktopSyncBatchOutcome.Success)?.value, 3);
  assert.equal(byOutcome.get(DesktopSyncBatchOutcome.Failure)?.value, 1);
  assert.deepEqual(byOutcome.get(DesktopSyncBatchOutcome.Success)?.attributes, {
    "sync.outcome": "success",
    "sync.lane": "session_metadata",
  });

  // The flip, asserted on the same batches: every success span carries status
  // UNSET, which is exactly the state that falls through `keep-error-status` to
  // the probabilistic baseline. The spans that back the 3 are the droppable
  // ones, and the count survives anyway.
  const successSpans = records.filter(
    (record) =>
      record.signal === DesktopOtelSignal.Trace &&
      record.name === "sync.batch" &&
      record.attributes?.[TelemetryAttribute.SyncOutcome] ===
        DesktopSyncBatchOutcome.Success
  );
  assert.equal(successSpans.length, 3);
  assert.deepEqual(
    successSpans.map((record) => record.status?.code),
    [SpanStatusCode.Unset, SpanStatusCode.Unset, SpanStatusCode.Unset]
  );
});

test("counts a batch whose span the strict schema rejects, so a span-side regression cannot deflate the rate (ISS-7497)", async () => {
  const runtime = createTestRuntime({
    appVersion: "1.2.3",
    getAppInstallationId: () => "install_0123456789abcdef",
  });
  await runtime.start();

  // `payloadBytes` is `z.number().int().min(0)`, so a negative fails
  // `SyncTelemetrySchema.parse` and `emitSyncBatchEvent` swallows the throw —
  // this batch produces NO span at all. It still happened, so it must still be
  // counted; that is the whole reason the counter sits outside the span's try
  // block. Move the `recordSyncBatchOutcome` call inside that block and this
  // test goes red while every other assertion in the file stays green.
  runtime.emitSyncBatchEvent({
    outcome: DesktopSyncBatchOutcome.Success,
    lane: SyncLane.TranscriptArchive,
    payloadBytes: -1,
  });
  await runtime.shutdown();

  const records = runtime.getBufferedRecords();
  assert.deepEqual(
    records.filter(
      (record) =>
        record.signal === DesktopOtelSignal.Trace &&
        record.name === "sync.batch"
    ),
    []
  );

  const counts = records.filter(
    (record) =>
      record.signal === DesktopOtelSignal.Metric &&
      record.name === SyncBatchCounterName
  );
  assert.equal(counts.length, 1);
  assert.equal(counts[0]?.value, 1);
  assert.deepEqual(counts[0]?.attributes, {
    "sync.outcome": "success",
    "sync.lane": "transcript_archive",
  });
});

test("ships the sync counter on a fleet-scoped resource, so no stable install identifier reaches the metrics label space (ISS-7497)", async () => {
  const runtime = createTestRuntime({
    appVersion: "1.2.3",
    env: {
      CLOSEDLOOP_DEPLOYMENT_ENVIRONMENT_NAME: "desktop-prod",
    },
    getAppInstallationId: () => "install_0123456789abcdef",
    getDeviceId: () => "device_0123456789abcdef",
  });
  await runtime.start();

  runtime.emitSyncBatchEvent({
    outcome: DesktopSyncBatchOutcome.Success,
    lane: SyncLane.SessionMetadata,
    payloadBytes: 1024,
    latencyMs: 12,
  });
  await runtime.shutdown();

  const records = runtime.getBufferedRecords();
  const countRecord = records.find(
    (record) =>
      record.signal === DesktopOtelSignal.Metric &&
      record.name === SyncBatchCounterName
  );
  const spanRecord = records.find(
    (record) =>
      record.signal === DesktopOtelSignal.Trace && record.name === "sync.batch"
  );

  // POSITIVE CONTROL, on the same two keys and the same run: the span resource
  // DOES carry both identifiers. Without this the absence assertion below
  // passes just as happily against a runtime that resolved no identifiers at
  // all, which is the failure it is supposed to catch.
  assert.equal(
    spanRecord?.resourceAttributes?.[TelemetryAttribute.AppInstallationId],
    "install_0123456789abcdef"
  );
  assert.equal(
    spanRecord?.resourceAttributes?.[TelemetryAttribute.DeviceId],
    "device_0123456789abcdef"
  );

  // Whole-bag equality against wire literals, not a projection of
  // `FleetMetricResourceAttributeKeys`: building the expectation from the
  // allow-list would make this test agree with whatever that list happens to
  // say, including a future edit that puts an identifier back.
  assert.deepEqual(countRecord?.resourceAttributes, {
    "service.name": "cl-desktop",
    "service.version": "1.2.3",
    "deployment.environment.name": "desktop-prod",
  });
});

test("sync batch emission no-ops when runtime is unavailable or disabled", async () => {
  const idleRuntime = createTestRuntime();
  idleRuntime.emitSyncBatchEvent({
    outcome: DesktopSyncBatchOutcome.Success,
    payloadBytes: 1,
    latencyMs: 1,
  });
  assert.deepEqual(idleRuntime.getBufferedRecords(), []);

  const disabledRuntime = createTestRuntime({
    env: { OTEL_SDK_DISABLED: "1" },
  });
  await disabledRuntime.start();
  disabledRuntime.emitSyncBatchEvent({
    outcome: DesktopSyncBatchOutcome.DeadLetter,
    payloadBytes: 999_999,
  });
  assert.deepEqual(disabledRuntime.getBufferedRecords(), []);
});
