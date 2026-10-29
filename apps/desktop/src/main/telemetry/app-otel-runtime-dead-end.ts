/**
 * @file app-otel-runtime-dead-end.ts
 * @description ISS-7249: the record shape and payload builder for desktop
 * dead-end treatments, split out of `app-otel-runtime.ts` exactly as
 * `app-otel-runtime-onboarding.ts` is. Rides the keyless relay alongside the
 * import-health and onboarding counters.
 */
import {
  type AppTelemetry,
  AppTelemetrySchema,
  DEAD_END_RETRY_ATTEMPT_MAX,
  type DeadEndPhase,
  DeadEndPhase as DeadEndPhaseValues,
  type DeadEndReason,
  type DeadEndRetryOutcome,
  type DeadEndState,
  type DeadEndTreatment,
  DeadEndTreatment as DeadEndTreatmentValues,
} from "@closedloop-ai/telemetry-contract/app";
import { TelemetryAttribute } from "@closedloop-ai/telemetry-contract/attributes";
import type { Attributes } from "@opentelemetry/api";
import { recordRenderedDeadEnd } from "./dead-end-rate-record.js";

/** Log-record name and instrumentation scope for every dead-end record. */
export const DEAD_END_EVENT_NAME = "dead_end.treatment";
export const DEAD_END_LOGGER_NAME = "closedloop-desktop-dead-end";

/** Closed enums and bounded counts only — no identifier, name, content, or path. */
export type DesktopDeadEndEventInput = {
  treatment: DeadEndTreatment;
  phase: DeadEndPhase;
  state: DeadEndState;
  reason: DeadEndReason;
  retryOffered: boolean;
  retryAttempt: number;
  httpStatus?: number;
  retryOutcome?: DeadEndRetryOutcome;
};

export type DesktopDeadEndRecord = {
  name: string;
  attributes: AppTelemetry;
};

/**
 * The `.strict()` parse is the closed-world enforcement point: a regression that
 * attached a session id throws here rather than leaking it.
 *
 * Two fields are conditional because a default would be a claim we cannot make —
 * a status only when a response carried one (a `0` reads as a server answer that
 * never happened), and an outcome only on a settled retry.
 */
export function buildDeadEndRecord(
  input: DesktopDeadEndEventInput
): DesktopDeadEndRecord {
  const statusAttributes = isReportableHttpStatus(input.httpStatus)
    ? { [TelemetryAttribute.HttpResponseStatusCode]: input.httpStatus }
    : {};
  const outcomeAttributes =
    input.phase === DeadEndPhaseValues.RetrySettled && input.retryOutcome
      ? { [TelemetryAttribute.DeadEndRetryOutcome]: input.retryOutcome }
      : {};
  return {
    name: DEAD_END_EVENT_NAME,
    attributes: AppTelemetrySchema.parse({
      [TelemetryAttribute.DeadEndTreatment]: input.treatment,
      [TelemetryAttribute.DeadEndPhase]: input.phase,
      [TelemetryAttribute.DeadEndState]: input.state,
      [TelemetryAttribute.DeadEndReason]: input.reason,
      [TelemetryAttribute.DeadEndRetryOffered]: input.retryOffered,
      [TelemetryAttribute.DeadEndRetryAttempt]: clampRetryAttempt(
        input.retryAttempt
      ),
      ...statusAttributes,
      ...outcomeAttributes,
    }),
  };
}

/**
 * Unlike onboarding — which withholds the org because it is the pre-auth window
 * — a dead end happens on an authenticated surface, and "which org is hitting
 * these" is the first question the resulting panel is asked. The runtime's
 * multiplayer gate still decides whether an id exists to attach.
 */
export function withDeadEndOrganization(
  record: DesktopDeadEndRecord,
  organizationAttributes: Attributes
): DesktopDeadEndRecord {
  const organizationId =
    organizationAttributes[TelemetryAttribute.AppOrganizationId];
  if (typeof organizationId !== "string") {
    return record;
  }
  return {
    name: record.name,
    attributes: {
      ...record.attributes,
      [TelemetryAttribute.AppOrganizationId]: organizationId,
    },
  };
}

/**
 * Composes a dead-end record and hands it to `emit`, mirroring the
 * import-health and onboarding channels. The org attribute IS attached here,
 * unlike onboarding: a dead end happens on an authenticated surface the user
 * navigated to, and "which org is hitting these" is the first question asked of
 * the resulting panel. The caller's `getActivityOrganizationAttribute` still
 * owns the multiplayer gate, so a single-player install attaches nothing.
 *
 * Swallows everything: dead-end telemetry is best-effort per the desktop
 * exporter boundary rule, so a serialization or dispatch failure must never
 * throw through the runtime's export API or affect the surface whose failure it
 * describes.
 */
export function emitDeadEndRecord(
  input: DesktopDeadEndEventInput,
  emit: (record: DesktopDeadEndRecord) => void,
  organizationAttributes: Attributes
): void {
  try {
    emit(
      withDeadEndOrganization(buildDeadEndRecord(input), organizationAttributes)
    );
  } catch {
    // Best-effort by contract; see the docstring above.
  }
}

/** Clamp at BOTH ends: `Math.min` alone would let a negative count through. */
function clampRetryAttempt(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }
  return Math.min(DEAD_END_RETRY_ATTEMPT_MAX, Math.max(0, Math.trunc(value)));
}

function isReportableHttpStatus(status: number | undefined): status is number {
  return (
    typeof status === "number" &&
    Number.isInteger(status) &&
    status >= 100 &&
    status <= 599
  );
}

/**
 * ISS-12039: write a dead end's `dead_end.rate` record. Called by the recorder
 * BEFORE its per-process cap, so the numerator stays uncapped like the
 * denominator while the detailed record stays capped. A Cloud-mode dead end
 * writes none: Cloud reads go over HTTP and write no call record, so both
 * operands cover local-mode reads only. Absent `readsCloud` is Local. Both per
 * Perrin Upcott's rulings of 2026-10-05.
 */
export function recordDeadEndRate(
  input: DesktopDeadEndEventInput & { readsCloud?: boolean }
): void {
  if (
    input.phase === DeadEndPhaseValues.Rendered &&
    input.readsCloud !== true &&
    COUNTS_TOWARD_SESSION_RATE[input.treatment]
  ) {
    recordRenderedDeadEnd();
  }
}

/**
 * ISS-12039: the rate's denominator is the Sessions reads, so only the
 * treatments those reads produce count in its numerator. A Branches dead end
 * has no matching read in the denominator.
 */
const COUNTS_TOWARD_SESSION_RATE: Record<DeadEndTreatment, boolean> = {
  [DeadEndTreatmentValues.SessionsListStalled]: true,
  [DeadEndTreatmentValues.SessionsListUnavailable]: true,
  [DeadEndTreatmentValues.SessionsListEmpty]: true,
  [DeadEndTreatmentValues.SessionDetailStalled]: true,
  [DeadEndTreatmentValues.SessionDetailNotFound]: true,
  [DeadEndTreatmentValues.SessionDetailUnavailable]: true,
  [DeadEndTreatmentValues.BranchesListUnavailable]: false,
  [DeadEndTreatmentValues.BranchesListEmpty]: false,
  [DeadEndTreatmentValues.Unknown]: false,
};
