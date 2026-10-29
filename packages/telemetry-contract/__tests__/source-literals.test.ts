import { describe, expect, it } from "vitest";
import {
  DeprecatedCodeTelemetryAttributes,
  TelemetryAttribute,
  TelemetryServiceName,
} from "../src/attributes";
import { TelemetryEmitMetadataKey } from "../src/emit";
import { TelemetrySchemaName } from "../src/schema-name";

describe("canonical attribute literals", () => {
  /**
   * Every published wire literal, hand-listed and asserted with `toEqual` so
   * the guard fails BOTH ways: renaming or dropping a literal goes red, and so
   * does adding one without pinning it here. The listing is deliberately not
   * derived from `TelemetryAttribute` — comparing the map to itself would pin
   * nothing. ISS-7290: this case asserted with `toMatchObject` (a subset check)
   * while claiming exactness, so 58 literals — every one added since the
   * original v0.5 listing, across the api-span, sync, ipc, import, auth,
   * onboarding, update, dead_end, routine, and audit groups — were free to be
   * renamed or dropped with the guard still green.
   */
  it("exports the exact published attribute literals", () => {
    expect(TelemetryAttribute).toEqual({
      ServiceName: "service.name",
      ServiceVersion: "service.version",
      AppInstallationId: "app.installation.id",
      AppClientVersion: "app.client.version",
      DeviceId: "device.id",
      AppOrganizationId: "app.organization.id",
      UserId: "user.id",
      DeploymentEnvironmentName: "deployment.environment.name",
      ExceptionType: "exception.type",
      ExceptionMessage: "exception.message",
      ExceptionStacktrace: "exception.stacktrace",
      AppExceptionOrigin: "app.exception.origin",
      AppBootFailureKind: "app.boot_failure.kind",
      AppBootFailureOutcome: "app.boot_failure.outcome",
      AppOperatingMode: "app.operating_mode",
      AppLifecycleEvent: "app.lifecycle.event",
      AppAgentMonitorRuntimeStatus: "app.agent_monitor.runtime_status",
      AppTelemetryExportDroppedOversizeCount:
        "app.telemetry_export.dropped_oversize_count",
      AppTelemetryExportDroppedNoSessionCount:
        "app.telemetry_export.dropped_no_session_count",
      AppTelemetryExportDroppedRateLimitedCount:
        "app.telemetry_export.dropped_rate_limited_count",
      AppTelemetryExportDroppedCollectorUnavailableCount:
        "app.telemetry_export.dropped_collector_unavailable_count",
      AppTelemetryExportDroppedInvalidCount:
        "app.telemetry_export.dropped_invalid_count",
      AppTelemetryExportSentCount: "app.telemetry_export.sent_count",
      HttpRequestMethod: "http.request.method",
      HttpResponseStatusCode: "http.response.status_code",
      UrlPath: "url.path",
      DurationMs: "duration_ms",
      CodeFunctionName: "code.function.name",
      CodeFilePath: "code.file.path",
      CodeLineNumber: "code.line.number",
      CodeColumnNumber: "code.column.number",
      ErrorType: "error.type",
      AppErrorSource: "app.error.source",
      ArtifactType: "artifact.type",
      ArtifactStatus: "artifact.status",
      GenAiUsageInputTokens: "gen_ai.usage.input_tokens",
      GenAiUsageOutputTokens: "gen_ai.usage.output_tokens",
      GenAiRequestModel: "gen_ai.request.model",
      GenAiResponseId: "gen_ai.response.id",
      GenAiUsageCacheCreationInputTokens:
        "gen_ai.usage.cache_creation.input_tokens",
      GenAiUsageCacheReadInputTokens: "gen_ai.usage.cache_read.input_tokens",
      GenAiOperationName: "gen_ai.operation.name",
      SyncEvent: "sync.event",
      SyncOutcome: "sync.outcome",
      SyncPayloadBytes: "sync.payload_bytes",
      SyncLatencyMs: "sync.latency_ms",
      SyncReason: "sync.reason",
      SyncLane: "sync.lane",
      SyncDeadLetteredCount: "sync.dead_lettered_count",
      SyncBatchId: "sync.batch_id",
      SyncSessionCount: "sync.session_count",
      SyncAttempt: "sync.attempt",
      SyncPayloadShaping: "sync.payload_shaping",
      SyncTilingStrippedCount: "sync.tiling_stripped_count",
      SyncFreshestSessionLagMs: "sync.freshest_session_lag_ms",
      GenAiCostUsage: "gen_ai.cost.usage",
      GenAiPermissionDecision: "gen_ai.permission.decision",
      GenAiPermissionSource: "gen_ai.permission.source",
      HarnessName: "harness.name",
      IpcOperation: "ipc.operation",
      IpcMatchedCount: "ipc.matched_count",
      IpcPayloadBytes: "ipc.payload_bytes",
      IpcQueryExecution: "ipc.query_execution",
      IpcQueryRefusal: "ipc.query_refusal",
      IpcQuerySource: "ipc.query_source",
      IpcResultCount: "ipc.result_count",
      IpcScannedCount: "ipc.scanned_count",
      IpcSessionCount: "ipc.session_count",
      ImportEvent: "import.event",
      ImportOutcome: "import.outcome",
      ImportGroupLabel: "import.group_label",
      ImportGroupFailedCount: "import.group_failed_count",
      ImportSessionsIncomplete: "import.sessions_incomplete",
      ImportSessionsPendingRevision: "import.sessions_pending_revision",
      ImportSourcesRemaining: "import.sources_remaining",
      ImportIngestFailure: "import.ingest_failure",
      ImportIngestFailedCount: "import.ingest_failed_count",
      ImportParseDegradedSite: "import.parse_degraded_site",
      ImportSourcesQuarantinedParse: "import.sources_quarantined_parse",
      ImportSourcesQuarantinedImport: "import.sources_quarantined_import",
      AuthOutcome: "auth.outcome",
      AuthReason: "auth.reason",
      OnboardingStep: "onboarding.step",
      OnboardingEvent: "onboarding.event",
      OnboardingConsentLevel: "onboarding.consent_level",
      OnboardingAnalyticsAction: "onboarding_analytics.action",
      OnboardingAnalyticsReason: "onboarding_analytics.reason",
      OnboardingAnalyticsOriginalEvent: "onboarding_analytics.original_event",
      OnboardingAnalyticsStep: "onboarding_analytics.step",
      OnboardingAnalyticsFlowId: "onboarding_analytics.flow_id",
      UpdateEvent: "update.event",
      UpdateFromVersion: "update.from_version",
      UpdateToVersion: "update.to_version",
      UpdateFailureReason: "update.failure_reason",
      UpdateBootAttempts: "update.boot_attempts",
      UpdateCurrentVersionAgeDays: "update.current_version_age_days",
      DeadEndTreatment: "dead_end.treatment",
      DeadEndPhase: "dead_end.phase",
      DeadEndState: "dead_end.state",
      DeadEndReason: "dead_end.reason",
      DeadEndRetryOffered: "dead_end.retry_offered",
      DeadEndRetryAttempt: "dead_end.retry_attempt",
      DeadEndRetryOutcome: "dead_end.retry_outcome",
      RoutineId: "routine.id",
      RoutineEvent: "routine.event",
      RoutineTrigger: "routine.trigger",
      RoutineOutcome: "routine.outcome",
      RoutineFailureReason: "routine.failure_reason",
      RoutineStepIndex: "routine.step_index",
      AuditEvent: "audit.event",
      AuditActorKind: "audit.actor_kind",
      AuditDecision: "audit.decision",
    });
  });

  /**
   * The deprecated code-attribute aliases are pinned for the same reason: their
   * only other consumers iterate `Object.values(...)`, which compares the map
   * to itself and would stay green through a rename (ISS-7290). Nothing accepts
   * these names: `SpanTelemetrySchema` is `.strict()` (`src/span.ts`), so a
   * payload carrying one is rejected outright (`span.test.ts`, "rejects
   * deprecated experimental code aliases"). The map is the exclusion inventory
   * the compatibility suite walks to prove the names stay out of
   * `CodeSpanTelemetryAttributes` and `OtelTelemetryAttributes`
   * (`otel-semconv-compatibility.test.ts`), so a silent rename here would
   * shrink what those checks cover instead of failing them.
   */
  it("exports the exact deprecated code attribute aliases", () => {
    expect(DeprecatedCodeTelemetryAttributes).toEqual({
      CodeFunction: "code.function",
      CodeFilepath: "code.filepath",
      CodeLineno: "code.lineno",
      CodeColumn: "code.column",
      CodeNamespace: "code.namespace",
    });
  });

  it("exports the exact schema-name and emit metadata literals", () => {
    expect(TelemetrySchemaName).toEqual({
      App: "app",
      Resource: "resource",
      Span: "span",
      GenAi: "gen_ai",
      Sync: "sync",
      Permission: "permission",
      Ipc: "ipc",
    });
    expect(TelemetryEmitMetadataKey).toEqual({
      SchemaName: "telemetry.schema_name",
    });
  });

  it("exports the exact PRD-159 Stage 7 service-name literals", () => {
    expect(TelemetryServiceName).toEqual({
      Desktop: "cl-desktop",
    });
  });
});
