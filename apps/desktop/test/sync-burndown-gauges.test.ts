/**
 * @file sync-burndown-gauges.test.ts
 * @description ISS-9246 — the device-side sync burn-down reaches the metrics
 * pipeline, and an UNMEASURED figure stays absent rather than arriving as a `0`.
 *
 * The assertions read the data points a real `MeterProvider` collected after a
 * real {@link SyncBurndownReporter} sampled a fake store, and they are made from
 * the test body. No spy on `recordSyncBurndownSample` — a spy would stay green
 * on a gauge the strict attribute schema rejected, and on a reporter that never
 * called the sink at all.
 */
import assert from "node:assert/strict";
import { TelemetryAttribute } from "@closedloop-ai/telemetry-contract/attributes";
import {
  SyncBurndownGaugeName,
  SyncBurndownGaugeSchema,
  SyncLane,
} from "@closedloop-ai/telemetry-contract/sync";
import { metrics } from "@opentelemetry/api";
import {
  AggregationTemporality,
  InMemoryMetricExporter,
  MeterProvider,
  PeriodicExportingMetricReader,
} from "@opentelemetry/sdk-metrics";
import { afterEach, test } from "vitest";
import { OutboxResumeOutcome } from "../src/main/agent-sync/session-outbox-engine-state.js";
import type { SyncBurndownStoreSample } from "../src/main/database/sync-burndown-store.js";
import { withFleetScopedResource } from "../src/main/telemetry/fleet-scoped-metric-exporter.js";
import {
  DesktopOtelLocalBuffer,
  DesktopOtelMetricExporter,
} from "../src/main/telemetry/local-buffer-otel-exporters.js";
import { recordSyncBurndownSample } from "../src/main/telemetry/sync-burndown-gauges.js";
import { DesktopOtelSignal } from "../src/shared/renderer-otel-bridge-constants.js";
import { SYNC_LANE_IDS } from "../src/shared/sync-burndown-contract.js";
import { buildHarness, emptySample } from "./sync-burndown-reporter-harness.js";

type CollectedPoint = { name: string; value: number; lane: string | undefined };

let activeProvider: MeterProvider | null = null;
let activeExporter: InMemoryMetricExporter | null = null;
let activeBuffer: DesktopOtelLocalBuffer | null = null;

afterEach(async () => {
  if (activeProvider) {
    await activeProvider.shutdown();
  }
  activeProvider = null;
  activeExporter = null;
  activeBuffer = null;
  metrics.disable();
});

function startMeterProvider(): void {
  const exporter = new InMemoryMetricExporter(AggregationTemporality.DELTA);
  const provider = new MeterProvider({
    readers: [
      new PeriodicExportingMetricReader({
        exporter,
        // Long enough that nothing exports on its own timer: every collection in
        // this suite is the explicit `forceFlush()` below, so a case can never
        // pass on a point a neighbouring case's timer happened to ship.
        exportIntervalMillis: 600_000,
      }),
    ],
  });
  metrics.disable();
  metrics.setGlobalMeterProvider(provider);
  activeProvider = provider;
  activeExporter = exporter;
}

async function collectPoints(): Promise<CollectedPoint[]> {
  const provider = activeProvider;
  const exporter = activeExporter;
  if (!(provider && exporter)) {
    // Thrown rather than asserted: this is fixture wiring, and an assertion in a
    // helper outside a `test()` body is what `noMisplacedAssertion` forbids.
    throw new Error("meter provider was not started");
  }
  await provider.forceFlush();
  const points: CollectedPoint[] = [];
  for (const resourceMetrics of exporter.getMetrics()) {
    for (const scopeMetrics of resourceMetrics.scopeMetrics) {
      for (const metric of scopeMetrics.metrics) {
        for (const dataPoint of metric.dataPoints) {
          const lane = dataPoint.attributes[TelemetryAttribute.SyncLane];
          points.push({
            name: metric.descriptor.name,
            value: Number(dataPoint.value),
            lane: typeof lane === "string" ? lane : undefined,
          });
        }
      }
    }
  }
  return points;
}

/**
 * The metric pipeline `startDesktopOtelSdk` builds on its local-buffer path: the
 * production exporter, behind the production fleet-scoping wrapper, behind a
 * real `PeriodicExportingMetricReader`.
 *
 * Used instead of {@link startMeterProvider} wherever TEMPORALITY is what is
 * under test. An `InMemoryMetricExporter(DELTA)` answers DELTA for every
 * instrument type, so a suite built on it cannot observe the carry-forward that
 * `DesktopOtelMetricExporter.selectAggregationTemporality` is what prevents —
 * it would pass identically against an exporter that had never been taught the
 * distinction.
 */
function startProductionMetricPipeline(): void {
  const buffer = new DesktopOtelLocalBuffer(1000);
  const provider = new MeterProvider({
    readers: [
      new PeriodicExportingMetricReader({
        exporter: withFleetScopedResource(
          new DesktopOtelMetricExporter(buffer)
        ),
        exportIntervalMillis: 600_000,
      }),
    ],
  });
  metrics.disable();
  metrics.setGlobalMeterProvider(provider);
  activeProvider = provider;
  activeBuffer = buffer;
}

/**
 * Force one collection and take the points it appended, clearing the buffer so
 * the next call reports that collection ALONE. A carried-forward series is
 * re-exported on every cycle, so a test that read the buffer cumulatively could
 * not tell one from a point that was recorded again.
 */
async function collectExportedPoints(): Promise<CollectedPoint[]> {
  const provider = activeProvider;
  const buffer = activeBuffer;
  if (!(provider && buffer)) {
    // See collectPoints(): fixture wiring, so thrown rather than asserted.
    throw new Error("production metric pipeline was not started");
  }
  await provider.forceFlush();
  const points = buffer
    .snapshot()
    .filter((record) => record.signal === DesktopOtelSignal.Metric)
    .map((record) => {
      const lane = record.attributes?.[TelemetryAttribute.SyncLane];
      return {
        name: record.name ?? "",
        value: Number(record.value),
        lane: typeof lane === "string" ? lane : undefined,
      };
    });
  buffer.reset();
  return points;
}

function gaugeValue(
  points: CollectedPoint[],
  metricName: string,
  lane: string
): number | undefined {
  return points.find(
    (point) => point.name === metricName && point.lane === lane
  )?.value;
}

/** A store sample with a real, aged session-metadata backlog. */
function sampleWithSessionBacklog(): SyncBurndownStoreSample {
  const sample = emptySample();
  return {
    ...sample,
    sessionOutbox: {
      ...sample.sessionOutbox,
      pending: 7,
      readyPending: 7,
      deadLettered: 3,
      // The harness clock is 2026-08-06T12:00:00Z, so this is exactly 90s old.
      oldestPendingSinceIso: "2026-08-06T11:58:30.000Z",
    },
  };
}

test("ISS-9246: a reporter sample reaches the metrics pipeline as per-lane gauges", async () => {
  startMeterProvider();
  const harness = buildHarness({
    sample: sampleWithSessionBacklog(),
    onSample: recordSyncBurndownSample,
  });

  await harness.reporter.sampleOnce();
  const points = await collectPoints();

  // The three figures ISS-5387 already computed and only ever logged, asserted
  // by VALUE from the test body. Remove the `onSample` call in
  // `SyncBurndownReporter.emit` and all three of these go undefined.
  assert.equal(
    gaugeValue(
      points,
      SyncBurndownGaugeName.ItemsRemaining,
      SyncLane.SessionMetadata
    ),
    7
  );
  assert.equal(
    gaugeValue(
      points,
      SyncBurndownGaugeName.OldestPendingAgeMs,
      SyncLane.SessionMetadata
    ),
    90_000
  );
  assert.equal(
    gaugeValue(
      points,
      SyncBurndownGaugeName.DeadLettered,
      SyncLane.SessionMetadata
    ),
    3
  );

  // Every lane the reporter sampled is present and separately attributed, so a
  // fleet-wide rollup cannot silently sum incompatible populations.
  assert.deepEqual(
    new Set(
      points
        .filter((point) => point.name === SyncBurndownGaugeName.ItemsRemaining)
        .map((point) => point.lane)
    ),
    new Set(SYNC_LANE_IDS)
  );
});

test("ISS-9246: an UNMEASURED dead-letter count is absent, not a zero", async () => {
  startMeterProvider();
  // No session source key: `sync-burndown-store.ts` short-circuits before it
  // queries anything, so the lane's `deadLetteredCount` of 0 is a placeholder
  // and not a measurement. This is the exact `0`-that-means-unmeasured the
  // repo's bad-data rule forbids putting on a monitored channel.
  const harness = buildHarness({
    sample: sampleWithSessionBacklog(),
    onSample: recordSyncBurndownSample,
  });
  harness.setSourceKeys({ session: null });

  await harness.reporter.sampleOnce();
  const points = await collectPoints();

  assert.equal(
    gaugeValue(
      points,
      SyncBurndownGaugeName.DeadLettered,
      SyncLane.SessionMetadata
    ),
    undefined,
    "an unmeasured dead-letter count must not be published at all"
  );

  // The other half of the distinction, in the SAME collection so the assertion
  // above cannot pass on a pipeline that simply published nothing: a lane whose
  // zero IS measured still reports it.
  assert.equal(
    gaugeValue(
      points,
      SyncBurndownGaugeName.DeadLettered,
      SyncLane.TranscriptArchive
    ),
    0,
    "a measured zero must still be published"
  );
});

test("ISS-9246: a drained lane publishes a measured zero age, not silence", async () => {
  startMeterProvider();
  const harness = buildHarness({
    sample: emptySample(),
    onSample: recordSyncBurndownSample,
  });

  await harness.reporter.sampleOnce();
  const points = await collectPoints();

  // The metrics pipeline is CUMULATIVE, so a series that stops being recorded is
  // re-exported at its last value rather than going absent. A lane that measured
  // an empty queue therefore has to say "0" out loud; falling silent would leave
  // the previous backlog age standing and latch any monitor over it.
  assert.equal(
    gaugeValue(
      points,
      SyncBurndownGaugeName.OldestPendingAgeMs,
      SyncLane.SessionMetadata
    ),
    0
  );
  assert.equal(
    gaugeValue(
      points,
      SyncBurndownGaugeName.ItemsRemaining,
      SyncLane.SessionMetadata
    ),
    0
  );
});

test("ISS-9246: the gauge attribute schema is strict, so an unknown key cannot ride along", () => {
  // The version-skew rule that bit this repo before: a `.strict()` boundary
  // rejects the WHOLE record on an unrecognised key, so an attribute added to
  // the producer and not taught to the contract would not lose one field - it
  // would silently drop every burn-down point. Proving the rejection here is
  // what makes `recordLaneBurndown`'s single `parse` the place that fails.
  assert.equal(
    SyncBurndownGaugeSchema.safeParse({
      [TelemetryAttribute.SyncLane]: SyncLane.SessionMetadata,
    }).success,
    true
  );
  assert.equal(
    SyncBurndownGaugeSchema.safeParse({
      [TelemetryAttribute.SyncLane]: SyncLane.SessionMetadata,
      "sync.burndown.not_a_contract_key": 1,
    }).success,
    false
  );
  // A lane value this build does not know is rejected rather than published as
  // free text, which is what keeps the attribute's cardinality closed.
  assert.equal(
    SyncBurndownGaugeSchema.safeParse({
      [TelemetryAttribute.SyncLane]: "lane_from_a_newer_build",
    }).success,
    false
  );
});

test("ISS-9246: a lane payload missing the optional ISS-7401/7096/7246 fields still publishes", async () => {
  startMeterProvider();
  // A version-skewed store reply that carries none of the additive optional
  // counts. The burn-down must degrade to publishing what it DID measure rather
  // than throwing or fabricating the absent figures.
  const sample = sampleWithSessionBacklog();
  const skewed: SyncBurndownStoreSample = {
    ...sample,
    sessionOutbox: {
      ...sample.sessionOutbox,
      parkedPending: 0,
      withheld: 0,
    },
  };
  const harness = buildHarness({
    sample: skewed,
    onSample: recordSyncBurndownSample,
  });

  await harness.reporter.sampleOnce();
  const points = await collectPoints();

  assert.equal(
    gaugeValue(
      points,
      SyncBurndownGaugeName.ItemsRemaining,
      SyncLane.SessionMetadata
    ),
    7
  );
});

test("ISS-9246: a lane the store never queried publishes NO depth and NO age, not zeros", async () => {
  startMeterProvider();
  // The production shape of an unpaired or signed-out install. With no source
  // key `sync-burndown-store.ts` short-circuits before it runs a statement, and
  // the unread group rows fold to `pending: 0` with a null oldest-pending
  // timestamp — byte-identical to a lane that counted its queue and found it
  // empty. Both lanes whose counts come from that fold are dropped here at once;
  // the component lane already answers `null` for the same case in the store.
  const harness = buildHarness({
    sample: emptySample(),
    onSample: recordSyncBurndownSample,
  });
  harness.setSourceKeys({ session: null, invocation: null });

  await harness.reporter.sampleOnce();
  const points = await collectPoints();

  for (const lane of [SyncLane.SessionMetadata, SyncLane.InvocationParts]) {
    assert.equal(
      gaugeValue(points, SyncBurndownGaugeName.ItemsRemaining, lane),
      undefined,
      `${lane}: a depth nobody measured must not be published as a drained 0`
    );
    assert.equal(
      gaugeValue(points, SyncBurndownGaugeName.OldestPendingAgeMs, lane),
      undefined,
      `${lane}: an unmeasured lane has no backlog age, so none may be published`
    );
  }

  // POSITIVE CONTROL, in the same collection and off the same all-zero sample:
  // the transcript lane has no source key to lose, so it WAS queried and its
  // zeros are measurements. Without this the assertions above pass just as
  // happily against a pipeline that published nothing at all.
  assert.equal(
    gaugeValue(
      points,
      SyncBurndownGaugeName.ItemsRemaining,
      SyncLane.TranscriptArchive
    ),
    0
  );
  assert.equal(
    gaugeValue(
      points,
      SyncBurndownGaugeName.OldestPendingAgeMs,
      SyncLane.TranscriptArchive
    ),
    0
  );
});

test("ISS-9246: losing a source key retracts the lane instead of re-exporting its last real value", async () => {
  startProductionMetricPipeline();
  const harness = buildHarness({
    sample: sampleWithSessionBacklog(),
    onSample: recordSyncBurndownSample,
  });

  await harness.reporter.sampleOnce();
  const measured = await collectExportedPoints();

  // Precondition, not decoration: the transition under test does not exist
  // unless a REAL value was published first. A suite that starts unmeasured
  // observes only the never-published case, which is green with or without the
  // temporality selection this asserts.
  assert.equal(
    gaugeValue(
      measured,
      SyncBurndownGaugeName.DeadLettered,
      SyncLane.SessionMetadata
    ),
    3
  );
  assert.equal(
    gaugeValue(
      measured,
      SyncBurndownGaugeName.ItemsRemaining,
      SyncLane.SessionMetadata
    ),
    7
  );

  // The install signs out or unpairs: the key is gone, and the store now
  // short-circuits to the all-zero fold for that lane.
  harness.setSourceKeys({ session: null });
  harness.setSample(emptySample());
  await harness.reporter.sampleOnce();
  const unmeasured = await collectExportedPoints();

  for (const gauge of [
    SyncBurndownGaugeName.DeadLettered,
    SyncBurndownGaugeName.ItemsRemaining,
    SyncBurndownGaugeName.OldestPendingAgeMs,
  ]) {
    assert.equal(
      gaugeValue(unmeasured, gauge, SyncLane.SessionMetadata),
      undefined,
      `${gauge} must go absent, not carry its last measured value forward`
    );
  }

  // POSITIVE CONTROL: the pipeline is still exporting in this same second
  // collection, so the absences above are the retraction and not a dead reader.
  assert.equal(
    gaugeValue(
      unmeasured,
      SyncBurndownGaugeName.DeadLettered,
      SyncLane.TranscriptArchive
    ),
    0
  );
});

test("ISS-10082: a resume-blocked lane publishes NO backlog age, not a measured zero", async () => {
  startMeterProvider();
  // The gauge half of the distinction the log line already pins. This lane's
  // counts genuinely are zero and genuinely were counted, but every pass is
  // abandoned before it can enqueue, so a published `0` backlog age asserts a
  // drain over a wedged device. Driven through `recordSessionResumeOutcome`,
  // the production tee, rather than a hand-built lane row — the call site under
  // test is `measuredOldestPendingAgeMs`, reached only via the real reporter.
  const harness = buildHarness({
    sample: emptySample(),
    onSample: recordSyncBurndownSample,
  });
  harness.reporter.recordSessionResumeOutcome(OutboxResumeOutcome.ReadFailed);

  await harness.reporter.sampleOnce();
  const points = await collectPoints();

  assert.equal(
    gaugeValue(
      points,
      SyncBurndownGaugeName.OldestPendingAgeMs,
      SyncLane.SessionMetadata
    ),
    undefined,
    "a lane whose resume read is failing has measured no backlog age, so none may be published"
  );

  // POSITIVE CONTROL, in the same collection and off the same all-zero sample:
  // only the session lane carries the resume fault, so the transcript lane's
  // zeros are a counted drain and still publish. Without this the assertion
  // above is equally green against a pipeline that published nothing at all.
  assert.equal(
    gaugeValue(
      points,
      SyncBurndownGaugeName.OldestPendingAgeMs,
      SyncLane.TranscriptArchive
    ),
    0,
    "a counted-empty lane must still publish its measured zero"
  );
});

test("ISS-10380: counted-empty component inventory publishes no backlog age", async () => {
  startMeterProvider();
  const harness = buildHarness({
    sample: emptySample(),
    onSample: recordSyncBurndownSample,
  });

  await harness.reporter.sampleOnce();
  const points = await collectPoints();

  assert.equal(
    gaugeValue(
      points,
      SyncBurndownGaugeName.ItemsRemaining,
      SyncLane.ComponentInventory
    ),
    0,
    "the component remainder was measured, so the metrics pipeline is active"
  );
  assert.equal(
    gaugeValue(
      points,
      SyncBurndownGaugeName.OldestPendingAgeMs,
      SyncLane.ComponentInventory
    ),
    undefined,
    "a cursor sweep has no per-item timestamp from which to measure age"
  );
});
