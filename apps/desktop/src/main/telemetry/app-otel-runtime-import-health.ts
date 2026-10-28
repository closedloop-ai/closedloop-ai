/**
 * @file app-otel-runtime-import-health.ts
 * @description ISS-5103: the record shape and payload builder for the desktop
 * import-health counters, kept beside `app-otel-runtime.ts` rather than inside
 * it (the same split as `app-otel-runtime-lifecycle.ts`). The runtime keeps only
 * the started-state guard, the emit call, and the swallow; everything that knows
 * what an import-health record *is* lives here.
 */
import {
  type AppTelemetry,
  AppTelemetrySchema,
  type ImportGroupLabel,
  ImportHealthEvent,
  type ImportIngestFailure,
  type ImportOutcome,
  type ImportParseDegradedSite,
} from "@closedloop-ai/telemetry-contract/app";
import { TelemetryAttribute } from "@closedloop-ai/telemetry-contract/attributes";
import type { TelemetryHarnessName } from "@closedloop-ai/telemetry-contract/resource";
import type { QuarantinedStageCounts } from "../../shared/ingest-quarantine-contract.js";
import { SourceTimeoutStage } from "../../shared/ingest-quarantine-contract.js";

/** Log-record names, one per import-health record kind. */
export const IMPORT_GROUP_FAILED_EVENT_NAME = "import.group_failed";
export const IMPORT_HEALTH_EVENT_NAME = "import.health";
/** ISS-6116: the two harness-scoped backfill records. */
export const IMPORT_SOURCES_REMAINING_EVENT_NAME = "import.sources_remaining";
export const IMPORT_HARNESS_NOT_ADVANCING_EVENT_NAME =
  "import.harness_not_advancing";
export const IMPORT_INGEST_FAILED_EVENT_NAME = "import.ingest_failed";
/** ISS-8600: the three harness-scoped occurrence records. */
export const IMPORT_WATCH_LOST_EVENT_NAME = "import.watch_lost";
export const IMPORT_MATERIALIZE_FAILED_EVENT_NAME = "import.materialize_failed";
export const IMPORT_MATERIALIZE_TIMED_OUT_EVENT_NAME =
  "import.materialize_timed_out";
/** Instrumentation scope these records are emitted under. */
export const IMPORT_HEALTH_LOGGER_NAME = "closedloop-desktop-import-health";

/**
 * ISS-8600: the two materialize outcomes that emit. A deliberate cancel and a
 * clean pass are both absent BY CONSTRUCTION rather than filtered downstream,
 * so the emitting seam cannot be handed an outcome it would have to decide not
 * to report.
 */
export type MaterializeImportHealthEvent =
  | typeof ImportHealthEvent.MaterializeFailed
  | typeof ImportHealthEvent.MaterializeTimedOut;

/**
 * One desktop import-health record: a per-group failure counter (tagged with
 * the contract's closed `ImportGroupLabel` set), a per-reason collector
 * ingest-failure counter (the closed `ImportIngestFailure` set, ISS-6336), the
 * tally-window pass summary (the window's `ImportOutcome`, sessions flagged
 * `incomplete`, sessions stuck at the DATA_REVISION_IMPORT_PENDING sentinel,
 * and the ISS-6336 quarantine gauge), or one of ISS-6116's two harness-scoped
 * backfill records. Counts and closed enums only — never session ids, paths, or
 * content.
 */
export type DesktopImportHealthEventInput =
  | {
      kind: typeof ImportHealthEvent.GroupFailed;
      groupLabel: ImportGroupLabel;
      count: number;
    }
  | {
      kind: typeof ImportHealthEvent.Pass;
      outcome: ImportOutcome;
      sessionsIncomplete: number;
      /**
       * Omitted — never zero — on the `error` outcome, where the sentinel
       * sample failed and the survivor count was therefore never computed.
       */
      sessionsPendingRevision?: number;
      /**
       * ISS-6336 GAUGE: transcripts currently quarantined, split by the stage
       * that quarantined them. Present on every summarizable window INCLUDING
       * at zero — a gauge that only appears when non-zero cannot tell "nothing
       * is quarantined" from "this install stopped reporting", which is the
       * exact ambiguity ISS-6335 just removed from this record. Omitted only on
       * the `error` outcome, where nothing about the window was computed.
       */
      quarantinedByStage?: QuarantinedStageCounts;
    }
  | {
      /**
       * ISS-6336: one collector ingest-failure reason's count for the window.
       * Shaped exactly like the group-failure counter above — a closed enum plus
       * a count, one record per reason — so it rides the same emission path with
       * no new transport and no second event family.
       */
      kind: typeof ImportHealthEvent.IngestFailed;
      reason: ImportIngestFailure;
      count: number;
      /**
       * ISS-12036: for a parse-quality reason, WHICH folded file lost the lines.
       * Optional and omitted when the session's parse quality cannot attribute
       * it, and absent entirely on the `source_*` reasons, which describe a
       * source rather than a session's folded files.
       */
      degradedSite?: ImportParseDegradedSite;
    }
  | {
      /**
       * ISS-6116: the backfill denominator, one per harness the tracker knows a
       * count for, every settled window. Explicit and never omitted — zero
       * means "nothing left", and a gauge that went quiet instead could not be
       * told apart from a wedge or from a dead process.
       */
      kind: typeof ImportHealthEvent.SourcesRemaining;
      harness: TelemetryHarnessName;
      sourcesRemaining: number;
    }
  | {
      /**
       * ISS-6116: one harness made no forward progress this window. Carries the
       * denominator so the breach reads without joining it to the gauge — except
       * for a harness frozen in its SOURCE SCAN, which has no denominator yet.
       * Omitted there rather than zeroed: the count was never measured.
       */
      kind: typeof ImportHealthEvent.HarnessNotAdvancing;
      harness: TelemetryHarnessName;
      sourcesRemaining?: number;
    }
  | {
      /**
       * ISS-8600: a harness's live delivery stopped, or an OpenCode
       * materialize pass ended without fresh projections. Occurrences, not
       * window tallies, and deliberately carrying NO count: watcher exhaustion
       * fires at a fixed threshold, so an attempt count would be a constant
       * dressed as a measurement, and `sourcesRemaining` describes a backfill
       * denominator these records were not measured against.
       */
      kind: typeof ImportHealthEvent.WatchLost | MaterializeImportHealthEvent;
      harness: TelemetryHarnessName;
    };

/** The record kinds whose whole payload is `{import.event, harness.name}`. */
type HarnessScopedImportHealthEventInput = Extract<
  DesktopImportHealthEventInput,
  { harness: TelemetryHarnessName }
>;

/**
 * Log-record name per harness-scoped kind.
 *
 * A `Record` over the kind union rather than a chain of ternaries, so a kind
 * added to {@link DesktopImportHealthEventInput} without a name fails `tsc`
 * here instead of reaching the wire under a neighbour's name.
 */
const HARNESS_SCOPED_IMPORT_HEALTH_EVENT_NAMES: Record<
  HarnessScopedImportHealthEventInput["kind"],
  string
> = {
  [ImportHealthEvent.SourcesRemaining]: IMPORT_SOURCES_REMAINING_EVENT_NAME,
  [ImportHealthEvent.HarnessNotAdvancing]:
    IMPORT_HARNESS_NOT_ADVANCING_EVENT_NAME,
  [ImportHealthEvent.WatchLost]: IMPORT_WATCH_LOST_EVENT_NAME,
  [ImportHealthEvent.MaterializeFailed]: IMPORT_MATERIALIZE_FAILED_EVENT_NAME,
  [ImportHealthEvent.MaterializeTimedOut]:
    IMPORT_MATERIALIZE_TIMED_OUT_EVENT_NAME,
};

/** The name + validated attributes to emit for one import-health record. */
export type DesktopImportHealthRecord = {
  name: string;
  attributes: AppTelemetry;
};

/**
 * Build the log-record payload for `input`.
 *
 * The `.strict()` closed-world parse is the enforcement point: only the
 * `import.*` count/enum attributes can ship, so a regression that tried to
 * attach a session id or a path throws here rather than leaking it. Throwing is
 * intended — the caller swallows, per the desktop exporter-boundary rule.
 *
 * Each literal is annotated `AppTelemetry` rather than left inferred, so a key
 * the strict schema has not learned fails `tsc` here instead of silently making
 * the schema reject — and re-reject on every retry — the whole record.
 */
export function buildImportHealthRecord(
  input: DesktopImportHealthEventInput
): DesktopImportHealthRecord {
  if (input.kind === ImportHealthEvent.GroupFailed) {
    const groupAttributes: AppTelemetry = {
      [TelemetryAttribute.ImportEvent]: ImportHealthEvent.GroupFailed,
      [TelemetryAttribute.ImportGroupLabel]: input.groupLabel,
      [TelemetryAttribute.ImportGroupFailedCount]: input.count,
    };
    return {
      name: IMPORT_GROUP_FAILED_EVENT_NAME,
      attributes: AppTelemetrySchema.parse(groupAttributes),
    };
  }
  if (input.kind === ImportHealthEvent.IngestFailed) {
    const ingestAttributes: AppTelemetry = {
      [TelemetryAttribute.ImportEvent]: ImportHealthEvent.IngestFailed,
      [TelemetryAttribute.ImportIngestFailure]: input.reason,
      [TelemetryAttribute.ImportIngestFailedCount]: input.count,
      // ISS-12036: spread so an unattributable window OMITS the key rather than
      // shipping a null the closed enum would reject.
      ...(input.degradedSite === undefined
        ? {}
        : {
            [TelemetryAttribute.ImportParseDegradedSite]: input.degradedSite,
          }),
    };
    return {
      name: IMPORT_INGEST_FAILED_EVENT_NAME,
      attributes: AppTelemetrySchema.parse(ingestAttributes),
    };
  }
  if (isHarnessScopedImportHealthEvent(input)) {
    const harnessAttributes: AppTelemetry = {
      [TelemetryAttribute.ImportEvent]: input.kind,
      [TelemetryAttribute.HarnessName]: input.harness,
    };
    // Absent, not zero — a frozen source scan has no denominator yet, and the
    // same rule the pass record follows for an uncomputed survivor count. The
    // ISS-8600 occurrence kinds have no such field at all, so they take the
    // same absence without a second branch.
    if ("sourcesRemaining" in input && input.sourcesRemaining !== undefined) {
      harnessAttributes[TelemetryAttribute.ImportSourcesRemaining] =
        input.sourcesRemaining;
    }
    return {
      name: HARNESS_SCOPED_IMPORT_HEALTH_EVENT_NAMES[input.kind],
      attributes: AppTelemetrySchema.parse(harnessAttributes),
    };
  }
  const passAttributes: AppTelemetry = {
    [TelemetryAttribute.ImportEvent]: ImportHealthEvent.Pass,
    [TelemetryAttribute.ImportOutcome]: input.outcome,
    [TelemetryAttribute.ImportSessionsIncomplete]: input.sessionsIncomplete,
  };
  // Absent, not null and not zero: an uncomputed survivor count must not read
  // as "nothing is stuck" (and an omitted optional is what the cross-process
  // contract expects for a value the producer does not have).
  if (input.sessionsPendingRevision !== undefined) {
    passAttributes[TelemetryAttribute.ImportSessionsPendingRevision] =
      input.sessionsPendingRevision;
  }
  // Both stages or neither, and a zero is WRITTEN rather than skipped. Reading
  // them off the `QuarantinedStageCounts` record (a `Record` over the stage
  // union) is what makes a newly added stage fail typecheck here instead of
  // silently never reaching the wire.
  if (input.quarantinedByStage) {
    passAttributes[TelemetryAttribute.ImportSourcesQuarantinedParse] =
      input.quarantinedByStage[SourceTimeoutStage.Parse];
    passAttributes[TelemetryAttribute.ImportSourcesQuarantinedImport] =
      input.quarantinedByStage[SourceTimeoutStage.Import];
  }
  return {
    name: IMPORT_HEALTH_EVENT_NAME,
    attributes: AppTelemetrySchema.parse(passAttributes),
  };
}

/**
 * Whether this record's whole payload is `{import.event, harness.name}`.
 *
 * Derived from {@link HARNESS_SCOPED_IMPORT_HEALTH_EVENT_NAMES} rather than
 * from a second list of kinds: a side inventory of the same members widens to
 * `string` and lets a newly added kind fall silently to the pass branch, while
 * a key read off the name map cannot exist without the map naming it.
 * `Object.hasOwn` rather than `in`, so no kind can be answered by a prototype
 * member.
 */
function isHarnessScopedImportHealthEvent(
  input: DesktopImportHealthEventInput
): input is HarnessScopedImportHealthEventInput {
  return Object.hasOwn(HARNESS_SCOPED_IMPORT_HEALTH_EVENT_NAMES, input.kind);
}
