import {
  AgentMonitorRuntimeStatusKind,
  AuthOutcome,
  DEAD_END_RETRY_ATTEMPT_MAX,
  ImportHealthEvent,
  ImportIngestFailure,
  ROUTINE_STEP_INDEX_MAX,
} from "../app";
import {
  AppBootFailureKind,
  AppBootFailureOutcome,
} from "../app-boot-failure-kind";
import { TelemetryAttribute } from "../src/attributes";
import {
  TelemetryDurationMsMax,
  TelemetryTextMaxLength,
} from "../src/schema-primitives";
import { appPayload } from "../src/test-fixtures";
import {
  maxUnicodeText,
  overflowUnicodeText,
  type SchemaCheck,
} from "./json-schema-parity-fixtures";

/**
 * Parity cases for the generated `app.schema.json`.
 *
 * The app schema is the one every new attribute group lands on, so its case
 * table is the half of the parity check that actually churns; it lives apart
 * from the Ajv runner for that reason (ISS-6313).
 */
export const appSchemaCheck: SchemaCheck = {
  path: "dist/schemas/app.schema.json",
  id: "https://closedloop.ai/schemas/telemetry-contract/app/v0.3.schema.json",
  // ISS-8600: `import.event` is the discriminator every import-health consumer
  // switches on, and the payload table below can only pin the members somebody
  // listed by hand. Derived instead, so the next value added to
  // `ImportHealthEvent` is covered by the change that adds it rather than by a
  // fourth remembered case. The source-side exact-set test pins the Zod enum;
  // this pins the published artifact a cross-repo consumer validates against.
  enumParity: [
    {
      attribute: TelemetryAttribute.AuthOutcome,
      members: Object.values(AuthOutcome),
    },
    {
      attribute: TelemetryAttribute.ImportEvent,
      members: Object.values(ImportHealthEvent),
    },
  ],
  validPayloads: [
    {
      name: "empty app payload",
      payload: {},
    },
    {
      name: "all app fields",
      payload: {
        [TelemetryAttribute.AppInstallationId]: maxUnicodeText(
          TelemetryTextMaxLength.AppInstallationId
        ),
        [TelemetryAttribute.AppOrganizationId]: maxUnicodeText(
          TelemetryTextMaxLength.AppOrganizationId
        ),
        [TelemetryAttribute.DeploymentEnvironmentName]: maxUnicodeText(
          TelemetryTextMaxLength.DeploymentEnvironmentName
        ),
        [TelemetryAttribute.ExceptionType]: maxUnicodeText(
          TelemetryTextMaxLength.ExceptionType
        ),
        [TelemetryAttribute.ExceptionMessage]: maxUnicodeText(
          TelemetryTextMaxLength.ExceptionMessage
        ),
        [TelemetryAttribute.ExceptionStacktrace]: maxUnicodeText(
          TelemetryTextMaxLength.ExceptionStacktrace
        ),
        [TelemetryAttribute.AppExceptionOrigin]: "main",
        [TelemetryAttribute.AppOperatingMode]: "single_player",
        [TelemetryAttribute.AppLifecycleEvent]: "heartbeat",
      },
    },
    {
      name: "routine execution and audit fields (ISS-6313)",
      payload: {
        [TelemetryAttribute.RoutineId]: "3f2504e0-4f89-41d3-9a0c-0305e82c3301",
        [TelemetryAttribute.RoutineEvent]: "settled",
        [TelemetryAttribute.RoutineTrigger]: "schedule",
        [TelemetryAttribute.RoutineOutcome]: "skipped",
        [TelemetryAttribute.RoutineFailureReason]: "step_error",
        [TelemetryAttribute.RoutineStepIndex]: 4,
        [TelemetryAttribute.DurationMs]: 12_345,
        [TelemetryAttribute.AuditEvent]: "entry_recorded",
        [TelemetryAttribute.AuditActorKind]: "agent",
        [TelemetryAttribute.AuditDecision]: "auto_approved",
      },
    },
    {
      name: "onboarding analytics discard fields (ISS-12421)",
      payload: {
        [TelemetryAttribute.OnboardingAnalyticsAction]: "event_dropped",
        [TelemetryAttribute.OnboardingAnalyticsReason]: "queue_overflow",
        [TelemetryAttribute.OnboardingAnalyticsOriginalEvent]: "page_viewed",
        [TelemetryAttribute.OnboardingAnalyticsStep]: "connect_github",
        [TelemetryAttribute.OnboardingAnalyticsFlowId]:
          "90069504-7d38-4678-9e99-88637ed9333a",
        [TelemetryAttribute.DurationMs]: 2000,
      },
    },
    // The Zod side asserts these land; the generated schema is a separate
    // artifact and can lose an enum member on its own. A version-skew default
    // the JSON Schema does not know rejects the whole record at whichever
    // consumer validates against the published file.
    {
      name: "version-skew safe defaults on every non-discriminator enum (ISS-6313)",
      payload: {
        [TelemetryAttribute.RoutineTrigger]: "unknown",
        [TelemetryAttribute.RoutineOutcome]: "unknown",
        [TelemetryAttribute.RoutineFailureReason]: "unknown",
        [TelemetryAttribute.AuditActorKind]: "unknown",
        [TelemetryAttribute.AuditDecision]: "unknown",
      },
    },
    {
      name: "dead-end treatment fields (ISS-7249)",
      payload: {
        [TelemetryAttribute.DeadEndTreatment]: "session_detail_unavailable",
        [TelemetryAttribute.DeadEndPhase]: "retry_settled",
        [TelemetryAttribute.DeadEndState]: "unavailable",
        [TelemetryAttribute.DeadEndReason]: "fetch_failed",
        [TelemetryAttribute.DeadEndRetryOffered]: true,
        [TelemetryAttribute.DeadEndRetryAttempt]: 2,
        [TelemetryAttribute.DeadEndRetryOutcome]: "still_dead_end",
        [TelemetryAttribute.HttpResponseStatusCode]: 503,
      },
    },
    // ISS-6336: the Zod side covers these four, but the generated file is a
    // separate artifact that can lose an enum member or a bound on its own, and
    // it is what a cross-repo consumer validates against.
    {
      name: "collector ingest-failure occurrence fields (ISS-6336)",
      payload: {
        [TelemetryAttribute.ImportEvent]: ImportHealthEvent.IngestFailed,
        [TelemetryAttribute.ImportIngestFailure]:
          ImportIngestFailure.SessionParseUnreadable,
        [TelemetryAttribute.ImportIngestFailedCount]: 2,
      },
    },
    // Zero is the value the quarantine GAUGE exists to carry: it separates "no
    // poison transcripts" from "this install stopped reporting". A generated
    // schema that emitted `exclusiveMinimum` instead of `minimum` would reject
    // it while the Zod side kept accepting it.
    {
      name: "quarantine gauge at zero (ISS-6336)",
      payload: {
        [TelemetryAttribute.ImportSourcesQuarantinedParse]: 0,
        [TelemetryAttribute.ImportSourcesQuarantinedImport]: 0,
      },
    },
    // ISS-9082: `failed` is the member the signal exists to carry — a
    // regenerated schema that dropped it would leave a dead install's
    // heartbeat rejected whole while every Zod test stayed green.
    {
      name: "agent-monitor capture-liveness status (ISS-9082)",
      payload: {
        [TelemetryAttribute.AppLifecycleEvent]: "heartbeat",
        [TelemetryAttribute.AppAgentMonitorRuntimeStatus]:
          AgentMonitorRuntimeStatusKind.Failed,
      },
    },
    // ISS-11866: the five per-cause transport drop counts and the sent count at
    // zero. A generated schema that emitted `exclusiveMinimum` would reject the
    // heartbeat of every install whose lane dropped nothing.
    {
      name: "telemetry-export counts at zero (ISS-11866)",
      payload: {
        [TelemetryAttribute.AppLifecycleEvent]: "heartbeat",
        [TelemetryAttribute.AppTelemetryExportDroppedOversizeCount]: 0,
        [TelemetryAttribute.AppTelemetryExportDroppedNoSessionCount]: 0,
        [TelemetryAttribute.AppTelemetryExportDroppedRateLimitedCount]: 0,
        [TelemetryAttribute.AppTelemetryExportDroppedCollectorUnavailableCount]: 0,
        [TelemetryAttribute.AppTelemetryExportDroppedInvalidCount]: 0,
        [TelemetryAttribute.AppTelemetryExportSentCount]: 0,
      },
    },
    // ISS-9259: the recovered store-open timeout — kind and outcome on ONE
    // record. A regenerated schema that dropped `recovered` would reject the
    // whole recovery report, which is the observability hole #6665 closed.
    {
      name: "recovered store-open boot timeout (ISS-9259)",
      payload: {
        [TelemetryAttribute.AppBootFailureKind]:
          AppBootFailureKind.StoreOpenTimeout,
        [TelemetryAttribute.AppBootFailureOutcome]:
          AppBootFailureOutcome.Recovered,
      },
    },
  ],
  invalidPayloads: [
    {
      name: "unknown app attribute",
      payload: appPayload({ "app.unknown": "value" }),
    },
    {
      name: "unknown ingest-failure reason (ISS-6336)",
      payload: appPayload({
        [TelemetryAttribute.ImportIngestFailure]: "threw",
      }),
    },
    // ISS-9259: the closed pair is what lets a monitor exclude a healthy install
    // by NEGATION. A generated schema that widened it to a bare string would
    // accept a third spelling that no query excludes.
    {
      name: "unknown boot-failure outcome (ISS-9259)",
      payload: appPayload({
        [TelemetryAttribute.AppBootFailureOutcome]: "retried",
      }),
    },
    // ISS-9082: the closed set is the whole privacy and cardinality control on
    // this attribute; a generated schema that widened it to a bare string
    // would accept anything the producer could ever put there.
    {
      name: "unknown agent-monitor runtime status (ISS-9082)",
      payload: appPayload({
        [TelemetryAttribute.AppAgentMonitorRuntimeStatus]: "degraded",
      }),
    },
    {
      name: "fractional telemetry-export drop count (ISS-11866)",
      payload: appPayload({
        [TelemetryAttribute.AppTelemetryExportDroppedCollectorUnavailableCount]: 1.5,
      }),
    },
    {
      name: "fractional telemetry-export sent count (ISS-11866)",
      payload: appPayload({
        [TelemetryAttribute.AppTelemetryExportSentCount]: 2.5,
      }),
    },
    {
      name: "negative telemetry-export drop count (ISS-11866)",
      payload: appPayload({
        [TelemetryAttribute.AppTelemetryExportDroppedNoSessionCount]: -1,
      }),
    },
    // The occurrence count and both gauges are nonnegative integers. Without
    // the fractional cases a regenerated schema that widened `integer` to
    // `number` would still pass every enum and floor case above.
    {
      name: "negative ingest-failure count (ISS-6336)",
      payload: appPayload({
        [TelemetryAttribute.ImportIngestFailedCount]: -1,
      }),
    },
    {
      name: "fractional ingest-failure count (ISS-6336)",
      payload: appPayload({
        [TelemetryAttribute.ImportIngestFailedCount]: 1.5,
      }),
    },
    {
      name: "negative parse quarantine gauge (ISS-6336)",
      payload: appPayload({
        [TelemetryAttribute.ImportSourcesQuarantinedParse]: -1,
      }),
    },
    {
      name: "fractional import quarantine gauge (ISS-6336)",
      payload: appPayload({
        [TelemetryAttribute.ImportSourcesQuarantinedImport]: 2.5,
      }),
    },
    {
      name: "unknown routine trigger",
      payload: appPayload({
        [TelemetryAttribute.RoutineTrigger]: "cron",
      }),
    },
    {
      name: "non-terminal routine status used as an outcome",
      payload: appPayload({
        [TelemetryAttribute.RoutineOutcome]: "running",
      }),
    },
    {
      name: "unknown routine event",
      payload: appPayload({
        [TelemetryAttribute.RoutineEvent]: "queued",
      }),
    },
    {
      name: "unknown routine failure reason",
      payload: appPayload({
        [TelemetryAttribute.RoutineFailureReason]: "network",
      }),
    },
    {
      name: "unknown audit event",
      payload: appPayload({
        [TelemetryAttribute.AuditEvent]: "entry_deleted",
      }),
    },
    {
      name: "audit actor kind respelled away from the ledger token",
      payload: appPayload({
        [TelemetryAttribute.AuditActorKind]: "human",
      }),
    },
    {
      name: "unknown audit decision",
      payload: appPayload({
        [TelemetryAttribute.AuditDecision]: "pending",
      }),
    },
    {
      name: "routine id carrying a name alongside the uuid",
      payload: appPayload({
        [TelemetryAttribute.RoutineId]:
          "3f2504e0-4f89-41d3-9a0c-0305e82c3301 nightly upgrade",
      }),
    },
    {
      name: "onboarding analytics flow id that is not a uuid",
      payload: appPayload({
        [TelemetryAttribute.OnboardingAnalyticsFlowId]: "flow-1",
      }),
    },
    {
      name: "unknown onboarding analytics drop reason",
      payload: appPayload({
        [TelemetryAttribute.OnboardingAnalyticsReason]: "network_error",
      }),
    },
    {
      name: "routine id that is not a uuid",
      payload: appPayload({
        [TelemetryAttribute.RoutineId]: "rt_01H8XABCDEF",
      }),
    },
    {
      name: "negative routine step index",
      payload: appPayload({
        [TelemetryAttribute.RoutineStepIndex]: -1,
      }),
    },
    {
      name: "routine step index above the reported ceiling",
      payload: appPayload({
        [TelemetryAttribute.RoutineStepIndex]: ROUTINE_STEP_INDEX_MAX + 1,
      }),
    },
    // A step position is a count, and `z.number().int()` generates
    // `"type": "integer"` — which Ajv enforces and a plain `"type": "number"`
    // would not. Without this case the generated schema could accept 1.5 and
    // the enum/min/max cases above would all still pass.
    {
      name: "fractional routine step index",
      payload: appPayload({
        [TelemetryAttribute.RoutineStepIndex]: 1.5,
      }),
    },
    // ISS-6313 put the routine/audit group on the canonical `duration_ms`
    // rather than a `routine.*` twin, which means the App schema gained a
    // bounded-integer attribute it never carried before. The span and IPC
    // schemas each pin their own duration bounds; the App projection is a
    // separate generated file and nothing here held it to the same three
    // edges, so a regenerated app.schema.json that dropped the bound,
    // the floor, or the integer type would have shipped green.
    {
      name: "negative app duration",
      payload: appPayload({
        [TelemetryAttribute.DurationMs]: -1,
      }),
    },
    {
      name: "fractional app duration",
      payload: appPayload({
        [TelemetryAttribute.DurationMs]: 1.5,
      }),
    },
    {
      name: "app duration above maximum",
      payload: appPayload({
        [TelemetryAttribute.DurationMs]: TelemetryDurationMsMax + 1,
      }),
    },
    {
      name: "unknown dead-end treatment",
      payload: appPayload({
        [TelemetryAttribute.DeadEndTreatment]: "branches_list_stalled",
      }),
    },
    {
      name: "unknown dead-end state",
      payload: appPayload({
        [TelemetryAttribute.DeadEndState]: "empty",
      }),
    },
    {
      name: "unknown dead-end reason",
      payload: appPayload({
        [TelemetryAttribute.DeadEndReason]: "network",
      }),
    },
    {
      name: "unknown dead-end phase",
      payload: appPayload({
        [TelemetryAttribute.DeadEndPhase]: "dismissed",
      }),
    },
    {
      name: "unknown dead-end retry outcome",
      payload: appPayload({
        [TelemetryAttribute.DeadEndRetryOutcome]: "failed",
      }),
    },
    {
      name: "negative dead-end retry attempt",
      payload: appPayload({
        [TelemetryAttribute.DeadEndRetryAttempt]: -1,
      }),
    },
    {
      name: "dead-end retry attempt above the reported ceiling",
      payload: appPayload({
        [TelemetryAttribute.DeadEndRetryAttempt]:
          DEAD_END_RETRY_ATTEMPT_MAX + 1,
      }),
    },
    {
      name: "dead-end retry offered as a string",
      payload: appPayload({
        [TelemetryAttribute.DeadEndRetryOffered]: "true",
      }),
    },
    {
      name: "http status outside the real response range",
      payload: appPayload({
        [TelemetryAttribute.HttpResponseStatusCode]: 0,
      }),
    },
    {
      name: "wrong app exception origin",
      payload: appPayload({
        [TelemetryAttribute.AppExceptionOrigin]: "worker",
      }),
    },
    {
      name: "wrong operating mode",
      payload: appPayload({
        [TelemetryAttribute.AppOperatingMode]: "co_op",
      }),
    },
    {
      name: "wrong lifecycle event",
      payload: appPayload({
        [TelemetryAttribute.AppLifecycleEvent]: "restart",
      }),
    },
    {
      name: "wrong type installation id",
      payload: appPayload({
        [TelemetryAttribute.AppInstallationId]: 123,
      }),
    },
    {
      name: "control character exception message",
      payload: appPayload({
        [TelemetryAttribute.ExceptionMessage]: "boom\nfailed",
      }),
    },
    {
      name: "installation id above Unicode maximum",
      payload: appPayload({
        [TelemetryAttribute.AppInstallationId]: overflowUnicodeText(
          TelemetryTextMaxLength.AppInstallationId
        ),
      }),
    },
    {
      name: "organization id above Unicode maximum",
      payload: appPayload({
        [TelemetryAttribute.AppOrganizationId]: overflowUnicodeText(
          TelemetryTextMaxLength.AppOrganizationId
        ),
      }),
    },
    {
      name: "control character organization id",
      payload: appPayload({
        [TelemetryAttribute.AppOrganizationId]: "org\nid",
      }),
    },
    {
      name: "deployment environment above Unicode maximum",
      payload: appPayload({
        [TelemetryAttribute.DeploymentEnvironmentName]: overflowUnicodeText(
          TelemetryTextMaxLength.DeploymentEnvironmentName
        ),
      }),
    },
    {
      name: "exception type above Unicode maximum",
      payload: appPayload({
        [TelemetryAttribute.ExceptionType]: overflowUnicodeText(
          TelemetryTextMaxLength.ExceptionType
        ),
      }),
    },
    {
      name: "exception message above Unicode maximum",
      payload: appPayload({
        [TelemetryAttribute.ExceptionMessage]: overflowUnicodeText(
          TelemetryTextMaxLength.ExceptionMessage
        ),
      }),
    },
    {
      name: "exception stacktrace above Unicode maximum",
      payload: appPayload({
        [TelemetryAttribute.ExceptionStacktrace]: overflowUnicodeText(
          TelemetryTextMaxLength.ExceptionStacktrace
        ),
      }),
    },
  ],
};
