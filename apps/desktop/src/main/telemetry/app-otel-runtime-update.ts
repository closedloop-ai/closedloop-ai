/**
 * @file app-otel-runtime-update.ts
 * @description ISS-7247 update lifecycle records, on the keyless relay — not the
 * auth-gated `Observability.emitTelemetry` lane, because the terminal record must
 * be joinable against the `app.lifecycle.event:start` that rides here. The
 * existing `electron_update.*` diagnostics stay auth-gated: they carry raw text.
 */
import {
  type AppTelemetry,
  AppTelemetrySchema,
  UpdateEvent,
  type UpdateFailureReason,
} from "@closedloop-ai/telemetry-contract/app";
import { TelemetryAttribute } from "@closedloop-ai/telemetry-contract/attributes";

/** Log-record name carried by every update lifecycle record. */
export const UPDATE_LIFECYCLE_EVENT_NAME = "update.lifecycle";
/** Instrumentation scope these records are emitted under. */
export const UPDATE_LIFECYCLE_LOGGER_NAME = "closedloop-desktop-update";

/**
 * One desktop update lifecycle record.
 *
 * `fromVersion` is the version the ATTEMPT started on, never `app.getVersion()`
 * read at emit time — on a terminal record this process already runs the new
 * build, so reading it live would collapse the from→to pair.
 */
export type DesktopUpdateEventInput = {
  event: UpdateEvent;
  fromVersion: string;
  /**
   * Absent — never `fromVersion` — when nothing was offered. The absence is
   * what distinguishes "up to date" from "offered and untaken".
   */
  toVersion?: string;
  /** Present only on the failure events. */
  failureReason?: UpdateFailureReason;
  /** Present only on the post-restart terminal events. */
  bootAttempts?: number;
  /** ISS-7225. Present only on `check`, once a first-seen date exists. */
  currentVersionAgeDays?: number;
};

/** The name + validated attributes to emit for one update lifecycle record. */
export type DesktopUpdateRecord = {
  name: string;
  attributes: AppTelemetry;
};

/**
 * The `.strict()` parse is the enforcement point: a regression attaching the raw
 * updater error throws here rather than leaking it, and the caller swallows per
 * the exporter-boundary rule. The `AppTelemetry` annotation makes an unlearned
 * key fail `tsc` rather than silently reject the whole record.
 */
export function buildUpdateLifecycleRecord(
  input: DesktopUpdateEventInput
): DesktopUpdateRecord {
  const attributes: AppTelemetry = {
    [TelemetryAttribute.UpdateEvent]: input.event,
    [TelemetryAttribute.UpdateFromVersion]: input.fromVersion,
  };
  if (input.toVersion !== undefined) {
    attributes[TelemetryAttribute.UpdateToVersion] = input.toVersion;
  }
  if (input.failureReason !== undefined) {
    attributes[TelemetryAttribute.UpdateFailureReason] = input.failureReason;
  }
  if (input.bootAttempts !== undefined) {
    attributes[TelemetryAttribute.UpdateBootAttempts] = input.bootAttempts;
  }
  if (input.currentVersionAgeDays !== undefined) {
    attributes[TelemetryAttribute.UpdateCurrentVersionAgeDays] =
      input.currentVersionAgeDays;
  }
  return {
    name: UPDATE_LIFECYCLE_EVENT_NAME,
    attributes: AppTelemetrySchema.parse(attributes),
  };
}

/** True for the two events that may only be produced on the far side of a restart. */
export function isPostRestartUpdateEvent(event: UpdateEvent): boolean {
  return (
    event === UpdateEvent.RestartedOnNewVersion ||
    event === UpdateEvent.RestartFailed
  );
}
