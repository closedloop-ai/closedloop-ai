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
} from "@closedloop-ai/telemetry-contract/app";
import { TelemetryAttribute } from "@closedloop-ai/telemetry-contract/attributes";

/** Log-record names, one per import-health record kind. */
export const IMPORT_GROUP_FAILED_EVENT_NAME = "import.group_failed";
export const IMPORT_HEALTH_EVENT_NAME = "import.health";
/** Instrumentation scope these records are emitted under. */
export const IMPORT_HEALTH_LOGGER_NAME = "closedloop-desktop-import-health";

/**
 * One desktop import-health record — either a per-group failure counter (tagged
 * with the contract's closed `ImportGroupLabel` set) or the tally-window pass
 * summary (sessions flagged `incomplete`, sessions stuck at the
 * DATA_REVISION_IMPORT_PENDING sentinel). Counts only — never session ids,
 * paths, or content.
 */
export type DesktopImportHealthEventInput =
  | {
      kind: typeof ImportHealthEvent.GroupFailed;
      groupLabel: ImportGroupLabel;
      count: number;
    }
  | {
      kind: typeof ImportHealthEvent.Pass;
      sessionsIncomplete: number;
      sessionsPendingRevision: number;
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
 */
export function buildImportHealthRecord(
  input: DesktopImportHealthEventInput
): DesktopImportHealthRecord {
  if (input.kind === ImportHealthEvent.GroupFailed) {
    return {
      name: IMPORT_GROUP_FAILED_EVENT_NAME,
      attributes: AppTelemetrySchema.parse({
        [TelemetryAttribute.ImportEvent]: ImportHealthEvent.GroupFailed,
        [TelemetryAttribute.ImportGroupLabel]: input.groupLabel,
        [TelemetryAttribute.ImportGroupFailedCount]: input.count,
      }),
    };
  }
  return {
    name: IMPORT_HEALTH_EVENT_NAME,
    attributes: AppTelemetrySchema.parse({
      [TelemetryAttribute.ImportEvent]: ImportHealthEvent.Pass,
      [TelemetryAttribute.ImportSessionsIncomplete]: input.sessionsIncomplete,
      [TelemetryAttribute.ImportSessionsPendingRevision]:
        input.sessionsPendingRevision,
    }),
  };
}
