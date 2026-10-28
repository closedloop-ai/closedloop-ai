/**
 * @file store-perf-telemetry.ts
 * @description ISS-6339 — emit the desktop SQLite PERFORMANCE signals on the
 * existing desktop telemetry transport.
 *
 * ## Why these are not methods on `Observability`
 *
 * The same two reasons `collector-records-dropped-telemetry.ts` gives:
 * `Observability` sits at the 1,000-line ceiling and is not grandfathered, and
 * its {@link Observability.storeIntegrityResult} owns a four-state cadence
 * machine that describes whether the store is CORRECT. Performance is a
 * different axis — a store can be perfectly intact and unusably slow — so
 * routing a slow-query sample through the integrity cadence would flip an
 * integrity monitor on a healthy store.
 *
 * ## Where these run
 *
 * Both are raised inside the db-host `utilityProcess`, which owns SQLite and the
 * migration runner. That process never calls `Observability.init`, so the emit
 * leaves it through the ISS-7109 relay sink and main re-emits it on the real
 * transport. Nothing here needs to know that; it is the same dumb emit main
 * would make.
 *
 * ## What they carry
 *
 * Counts, durations, byte gauges, and a statement FAMILY. No SQL text, no bound
 * values, no table or column names, no filesystem path. The migration `name` is
 * a directory name from this build's own embedded manifest — bounded by the
 * build, unlike the refusal path's name, which comes from the local store and is
 * deliberately kept off the wire (`../lifecycle/migration-refusal.ts`).
 */

import { Observability } from "./observability.js";
import {
  type MigrationStepDiagnostics,
  MigrationStepOutcome,
  type StorePerfDiagnostics,
  type TelemetryTraceContext,
} from "./telemetry-protocol.js";

/**
 * Report one periodic store-performance sample: the statement-duration
 * histogram, the slow-query counts, and the store/WAL size gauges.
 *
 * `dbSizeBytes` / `walSizeBytes` arrive already OMITTED when their read did not
 * resolve. This function does not substitute a zero for a missing gauge — a
 * zero would be indistinguishable from an empty store.
 */
export function reportStorePerfSample(sample: StorePerfDiagnostics): void {
  const trace: TelemetryTraceContext = {};
  const total = sample.families.reduce((sum, family) => sum + family.count, 0);
  const slow = sample.families.reduce(
    (sum, family) => sum + family.slowCount,
    0
  );
  Observability.getTelemetryEmitter().emit({
    severity: "info",
    category: "store.perf.sample",
    message: `Local store ran ${total} statement(s) in ${sample.windowMs}ms, ${slow} at or over ${sample.slowQueryThresholdMs}ms.`,
    trace,
    diagnostics: { storePerf: sample },
  });
}

/**
 * Report one boot migration step's duration and outcome.
 *
 * A failed step is `error` severity: the runner rethrows and the boot path
 * surfaces an Agent Monitor failure, so this event is the only record of WHICH
 * step and HOW LONG it ran before giving up.
 */
export function reportMigrationStep(step: MigrationStepDiagnostics): void {
  const trace: TelemetryTraceContext = {};
  Observability.getTelemetryEmitter().emit({
    severity: step.outcome === MigrationStepOutcome.Failed ? "error" : "info",
    category: "store.migration.step",
    message: `Local store migration ${step.name} ${step.outcome} in ${step.durationMs}ms.`,
    trace,
    diagnostics: { migrationStep: step },
  });
}
