/**
 * @file sync-sampling-bias.ts
 * @description Which sync measures the collector's tail sampling leaves whole,
 * and which are read off a population biased towards failure (ISS-7497).
 *
 * A `sync.batch` span is a CHILD of the desktop activity-window root, and
 * `tail_sampling` decides per TRACE: the window is kept whole when any span in
 * it trips a keep policy, and otherwise survives at
 * `CollectorTailSamplingPolicy.baselineSamplingPercentage`. A failure or
 * dead-letter batch sets span status ERROR, so it rides `keep-error-status` and
 * arrives complete. A successful batch trips nothing of its own — the sync group
 * does not carry `http.response.status_code`, the only attribute key a keep
 * policy still reads, and ISS-9254 moved `keep-slow` off attributes entirely
 * onto the trace's own wall-clock duration. So a success survives at the
 * baseline, plus whatever an unhealthy trace-mate incidentally keeps beside it,
 * plus whatever a long activity window keeps around it. A success is therefore
 * retained at no known constant rate, and no fixed reweight recovers the true
 * one.
 *
 * That is why a naive `failure / (success + failure)` is not merely noisy but
 * directionally wrong: the numerator is whole and the denominator is not.
 *
 * ISS-7497 fixed the RATE rather than only warning about it: `sync.batch.count`
 * (`SyncBatchCounterName`, in `../sync.ts`) counts every settled batch on the metrics
 * pipeline, which `tail_sampling` does not touch. Any rate — success, failure,
 * dead-letter, per lane — belongs to that counter. The span attributes below
 * stay per-batch forensics, and their retention is what this table describes.
 *
 * Note what the correlation costs the reads that are still span-side. A success
 * is retained by the baseline, OR whenever any span in the same activity window
 * errored, OR whenever that window ran long enough to trip `keep-slow` — so
 * inclusion is correlated with the health of the window and with how long it
 * lasted. That rules out percentiles and trends over the success population,
 * not just means — a sample whose inclusion probability moves with the thing
 * being measured has no unbiased statistic, only individually-real
 * observations.
 *
 * Prose with a compile guard, in the shape of `attribute-producer-mapping.ts`:
 * nothing here is read at runtime, and the `satisfies Record<...>` is what makes
 * a sync attribute added without a stated retention a compile error rather than
 * a dashboard nobody warned.
 */
import {
  type SyncTelemetryAttributes,
  TelemetryAttribute,
} from "./attributes.js";

/**
 * How much of an attribute's population survives to the backend.
 *
 * The table errs by UNDER-claiming: {@link SyncMeasureRetention.Mixed} is the
 * value both for an attribute genuinely carried on every outcome and for one the
 * contract's prose points to one side without this repo verifying it, so a
 * `Complete` or `Sampled` here is always a claim traced to a producer.
 */
export const SyncMeasureRetention = {
  /** Attached only on a span the policy retains deterministically: what arrives IS the population. */
  Complete: "complete",
  /** Attached only on a span with no deterministic keep path: what arrives is a sample. */
  Sampled: "sampled",
  /** Carried across both, so its population is part whole and part sample — the bias itself. */
  Mixed: "mixed",
} as const;

/** Literal union of retention classifications. */
export type SyncMeasureRetention =
  (typeof SyncMeasureRetention)[keyof typeof SyncMeasureRetention];

/** One attribute's retention, with the reads it does and does not support. */
export type SyncMeasureSamplingEntry = {
  readonly retention: SyncMeasureRetention;
  /** Aggregations this attribute answers without correction. */
  readonly sound: string;
  /** Aggregations it cannot answer, and what goes wrong when it is asked. */
  readonly unsound: string;
};

/** Per-attribute retention inventory for the sync group. */
export const SyncMeasureSampling = {
  [TelemetryAttribute.SyncEvent]: {
    retention: SyncMeasureRetention.Mixed,
    sound: "Identifying a span as a sync batch.",
    unsound:
      "Counting batches. Failures are whole and successes are a sample, so the total is neither.",
  },
  [TelemetryAttribute.SyncOutcome]: {
    retention: SyncMeasureRetention.Mixed,
    sound: "Failure and dead-letter counts, which arrive whole.",
    unsound:
      "Any RATE, from spans — the measure this ticket was filed for. Read it off the `sync.batch.count` metric instead, which counts every batch because `tail_sampling` is trace-only. A span-derived rate divides a whole failure numerator by a sampled success denominator and reads catastrophically worse than the fleet is.",
  },
  [TelemetryAttribute.SyncPayloadBytes]: {
    retention: SyncMeasureRetention.Mixed,
    sound: "Payload sizes of failed batches, which are retained whole.",
    unsound:
      "Any fleet-wide payload statistic, for the reason `sync.latency_ms` gives: the healthy half is a health-correlated sample, so the mix of the two is weighted towards whatever failures ship.",
  },
  [TelemetryAttribute.SyncLatencyMs]: {
    retention: SyncMeasureRetention.Mixed,
    sound: "Latency of failed batches, which are retained whole.",
    unsound:
      "Any fleet-wide statistic — mean, median, percentile or trend. Inclusion of a success is correlated with whether its activity window errored AND with how long that window ran, so no statistic over that population is unbiased; only the individual retained values are real. Since ISS-9254 `keep-slow` reads the whole trace's duration rather than a span attribute, so a long window is retained whole — a second, duration-correlated skew stacked on the health one, and still not the per-batch slow-side skew a latency sample is usually corrected for.",
  },
  [TelemetryAttribute.SyncReason]: {
    retention: SyncMeasureRetention.Complete,
    sound:
      "Reason mix and per-reason counts. The contract admits this attribute only as why a batch was a `failure` or `dead_letter`, and that span is retained whole.",
    unsound:
      "A per-reason rate against attempts. The attempt denominator is sampled even though this numerator is not.",
  },
  [TelemetryAttribute.SyncLane]: {
    retention: SyncMeasureRetention.Mixed,
    sound: "Which lane the failures come from, and in what proportion.",
    unsound: "Per-lane success rate or throughput.",
  },
  [TelemetryAttribute.SyncDeadLetteredCount]: {
    retention: SyncMeasureRetention.Complete,
    sound:
      "DLQ depth, by lane and by org. Attached only on the dead-letter arm, whose span is ERROR and retained whole — the one sync measure this ticket certifies as trustworthy.",
    unsound:
      "A dead-letter RATE. Dividing a whole count by attempts reintroduces the sampled denominator.",
  },
  [TelemetryAttribute.SyncBatchId]: {
    retention: SyncMeasureRetention.Mixed,
    sound: "Joining a span to the desktop-side record of the same attempt.",
    unsound: "Counting distinct batches.",
  },
  [TelemetryAttribute.SyncSessionCount]: {
    retention: SyncMeasureRetention.Mixed,
    sound:
      "Sessions per failed batch, and bytes-per-session against `sync.payload_bytes`, on the failure side.",
    unsound: "Fleet session throughput.",
  },
  [TelemetryAttribute.SyncAttempt]: {
    retention: SyncMeasureRetention.Mixed,
    sound: "Retry depth on the failures that carry it.",
    unsound:
      "What share of batches ever retry. A first attempt that then succeeds is on the sampled side.",
  },
  [TelemetryAttribute.SyncPayloadShaping]: {
    retention: SyncMeasureRetention.Mixed,
    sound: "How the payloads that failed had been reshaped.",
    unsound: "How often chunking happens at all.",
  },
  [TelemetryAttribute.SyncTilingStrippedCount]: {
    retention: SyncMeasureRetention.Mixed,
    sound: "Sessions that shipped without their tiling on a failed batch.",
    unsound: "A fleet strip rate.",
  },
  [TelemetryAttribute.SyncFreshestSessionLagMs]: {
    retention: SyncMeasureRetention.Sampled,
    sound:
      "Reading one retained value as a lag that genuinely occurred. Each observation is real even though the population is not.",
    unsound:
      "Every aggregate: threshold alarm, minimum, percentile, trend. Emitted from one call site on the accepted-ack path, so it rides ONLY the success span and is entirely on the sampled side, with inclusion correlated with the health of its activity window AND with how long that window ran — since ISS-9254 a window that trips `keep-slow` is retained whole. A quiet install can pass a whole alarm window with no retained sample while syncing normally, and that silence is indistinguishable from health. The 15-minute freshness alarm cannot be built on this without a decision to move it onto the metrics pipeline.",
  },
  [TelemetryAttribute.AppOrganizationId]: {
    retention: SyncMeasureRetention.Mixed,
    sound: "Attributing a retained span to a tenant.",
    unsound:
      "Per-org rates. Every measure above keeps its own retention once sliced by org; slicing narrows the population, it does not unbias it.",
  },
  [TelemetryAttribute.AppOperatingMode]: {
    retention: SyncMeasureRetention.Mixed,
    sound:
      "Telling a multiplayer batch awaiting attribution apart from a single-player one.",
    unsound: "Install counts by mode.",
  },
} as const satisfies Record<
  (typeof SyncTelemetryAttributes)[number],
  SyncMeasureSamplingEntry
>;
