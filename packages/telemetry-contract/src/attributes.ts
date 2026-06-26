/** Published telemetry attribute names shared by schemas and callers. */
export const TelemetryAttribute = {
  ServiceName: "service.name",
  ServiceVersion: "service.version",
  AppInstallationId: "app.installation.id",
  DeploymentEnvironmentName: "deployment.environment.name",
  ExceptionType: "exception.type",
  ExceptionMessage: "exception.message",
  ExceptionStacktrace: "exception.stacktrace",
  AppExceptionOrigin: "app.exception.origin",
  AppOperatingMode: "app.operating_mode",
  AppLifecycleEvent: "app.lifecycle.event",
  HttpRequestMethod: "http.request.method",
  HttpResponseStatusCode: "http.response.status_code",
  UrlPath: "url.path",
  DurationMs: "duration_ms",
  CodeFunctionName: "code.function.name",
  CodeFilePath: "code.file.path",
  CodeLineNumber: "code.line.number",
  CodeColumnNumber: "code.column.number",
  ErrorType: "error.type",
  GenAiUsageInputTokens: "gen_ai.usage.input_tokens",
  GenAiUsageOutputTokens: "gen_ai.usage.output_tokens",
  GenAiRequestModel: "gen_ai.request.model",
  GenAiResponseId: "gen_ai.response.id",
  GenAiUsageCacheCreationInputTokens:
    "gen_ai.usage.cache_creation.input_tokens",
  GenAiUsageCacheReadInputTokens: "gen_ai.usage.cache_read.input_tokens",
  SyncEvent: "sync.event",
  SyncOutcome: "sync.outcome",
  SyncPayloadBytes: "sync.payload_bytes",
  SyncLatencyMs: "sync.latency_ms",
  GenAiCostUsage: "gen_ai.cost.usage",
  GenAiPermissionDecision: "gen_ai.permission.decision",
  GenAiPermissionSource: "gen_ai.permission.source",
  HarnessName: "harness.name",
} as const;

/** Literal union of all published telemetry attribute names. */
export type TelemetryAttributeName =
  (typeof TelemetryAttribute)[keyof typeof TelemetryAttribute];

/** Ownership buckets for OTel-native and ClosedLoop compatibility attributes. */
export const TelemetryAttributeOwnership = {
  Otel: "otel",
  ClosedLoopCompatibility: "closedloop_compatibility",
} as const;

/** Literal union of telemetry attribute ownership buckets. */
export type TelemetryAttributeOwnership =
  (typeof TelemetryAttributeOwnership)[keyof typeof TelemetryAttributeOwnership];

/** Attributes allowed by the resource schema. */
export const ResourceTelemetryAttributes = [
  TelemetryAttribute.ServiceName,
  TelemetryAttribute.ServiceVersion,
  TelemetryAttribute.HarnessName,
] as const;

/** App-level identity, deployment, lifecycle, and exception attributes. */
export const AppTelemetryAttributes = [
  TelemetryAttribute.AppInstallationId,
  TelemetryAttribute.DeploymentEnvironmentName,
  TelemetryAttribute.ExceptionType,
  TelemetryAttribute.ExceptionMessage,
  TelemetryAttribute.ExceptionStacktrace,
  TelemetryAttribute.AppExceptionOrigin,
  TelemetryAttribute.AppOperatingMode,
  TelemetryAttribute.AppLifecycleEvent,
] as const;

/** OTel HTTP span attributes allowed by the span schema. */
export const HttpSpanTelemetryAttributes = [
  TelemetryAttribute.HttpRequestMethod,
  TelemetryAttribute.HttpResponseStatusCode,
  TelemetryAttribute.UrlPath,
] as const;

/** ClosedLoop compatibility span attributes allowed until native adoption. */
export const CompatibilitySpanTelemetryAttributes = [
  TelemetryAttribute.DurationMs,
] as const;

/** Optional source-code span attributes allowed by the span schema. */
export const CodeSpanTelemetryAttributes = [
  TelemetryAttribute.CodeFunctionName,
  TelemetryAttribute.CodeFilePath,
  TelemetryAttribute.CodeLineNumber,
  TelemetryAttribute.CodeColumnNumber,
] as const;

/** Optional error span attributes allowed by the span schema. */
export const ErrorSpanTelemetryAttributes = [
  TelemetryAttribute.ErrorType,
] as const;

/** GenAI attributes allowed by the gen_ai schema. */
export const GenAiTelemetryAttributes = [
  TelemetryAttribute.GenAiUsageInputTokens,
  TelemetryAttribute.GenAiUsageOutputTokens,
  TelemetryAttribute.GenAiRequestModel,
  TelemetryAttribute.GenAiResponseId,
  TelemetryAttribute.GenAiUsageCacheCreationInputTokens,
  TelemetryAttribute.GenAiUsageCacheReadInputTokens,
  TelemetryAttribute.GenAiCostUsage,
] as const;

/** Permission-decision attributes allowed by the permission schema. */
export const PermissionTelemetryAttributes = [
  TelemetryAttribute.GenAiPermissionDecision,
  TelemetryAttribute.GenAiPermissionSource,
] as const;

/** Sync transport-health attributes allowed by the sync schema. */
export const SyncTelemetryAttributes = [
  TelemetryAttribute.SyncEvent,
  TelemetryAttribute.SyncOutcome,
  TelemetryAttribute.SyncPayloadBytes,
  TelemetryAttribute.SyncLatencyMs,
] as const;

/** Attributes sourced from the pinned OpenTelemetry semantic conventions. */
export const OtelTelemetryAttributes = [
  TelemetryAttribute.ServiceName,
  TelemetryAttribute.ServiceVersion,
  TelemetryAttribute.AppInstallationId,
  TelemetryAttribute.DeploymentEnvironmentName,
  TelemetryAttribute.ExceptionType,
  TelemetryAttribute.ExceptionMessage,
  TelemetryAttribute.ExceptionStacktrace,
  TelemetryAttribute.HttpRequestMethod,
  TelemetryAttribute.HttpResponseStatusCode,
  TelemetryAttribute.UrlPath,
  TelemetryAttribute.CodeFunctionName,
  TelemetryAttribute.CodeFilePath,
  TelemetryAttribute.CodeLineNumber,
  TelemetryAttribute.CodeColumnNumber,
  TelemetryAttribute.ErrorType,
  TelemetryAttribute.GenAiUsageInputTokens,
  TelemetryAttribute.GenAiUsageOutputTokens,
  TelemetryAttribute.GenAiRequestModel,
  TelemetryAttribute.GenAiResponseId,
] as const;

/** Compatibility attributes owned by ClosedLoop until OTel parity exists. */
export const ClosedLoopCompatibilityAttribute = {
  AppExceptionOrigin: TelemetryAttribute.AppExceptionOrigin,
  AppOperatingMode: TelemetryAttribute.AppOperatingMode,
  AppLifecycleEvent: TelemetryAttribute.AppLifecycleEvent,
  DurationMs: TelemetryAttribute.DurationMs,
  GenAiUsageCacheCreationInputTokens:
    TelemetryAttribute.GenAiUsageCacheCreationInputTokens,
  GenAiUsageCacheReadInputTokens:
    TelemetryAttribute.GenAiUsageCacheReadInputTokens,
  SyncEvent: TelemetryAttribute.SyncEvent,
  SyncOutcome: TelemetryAttribute.SyncOutcome,
  SyncPayloadBytes: TelemetryAttribute.SyncPayloadBytes,
  SyncLatencyMs: TelemetryAttribute.SyncLatencyMs,
  GenAiCostUsage: TelemetryAttribute.GenAiCostUsage,
  GenAiPermissionDecision: TelemetryAttribute.GenAiPermissionDecision,
  GenAiPermissionSource: TelemetryAttribute.GenAiPermissionSource,
  HarnessName: TelemetryAttribute.HarnessName,
} as const;

/** Literal union of ClosedLoop compatibility telemetry attributes. */
export type ClosedLoopCompatibilityAttribute =
  (typeof ClosedLoopCompatibilityAttribute)[keyof typeof ClosedLoopCompatibilityAttribute];

/** Producer inventory explaining each compatibility attribute source. */
export const CompatibilityAttributeProducerMapping = {
  [TelemetryAttribute.AppExceptionOrigin]: {
    producer: "apps/desktop/src/main (desktop OTel SDK, FEA-1986)",
    sourceField: "exceptionOrigin",
    reason:
      "Desktop classifies exception telemetry origin as a ClosedLoop compatibility field until an OTel semantic convention owns this app-process projection.",
  },
  [TelemetryAttribute.AppOperatingMode]: {
    producer: "apps/desktop/src/main (desktop OTel SDK, FEA-1983)",
    sourceField: "operatingMode",
    reason:
      "Desktop emits the app operating mode as a ClosedLoop compatibility field until an OTel semantic convention owns this lifecycle projection.",
  },
  [TelemetryAttribute.AppLifecycleEvent]: {
    producer: "apps/desktop/src/main (desktop OTel SDK, FEA-1983)",
    sourceField: "lifecycleEvent",
    reason:
      "Desktop emits lifecycle event names as ClosedLoop compatibility fields until OTel defines an equivalent app lifecycle attribute.",
  },
  [TelemetryAttribute.DurationMs]: {
    producer: "apps/api/lib/route-utils.ts",
    sourceField: "duration_ms",
    reason:
      "Current request_completed logs emit duration_ms until downstream native span timing work adopts a canonical duration representation.",
  },
  [TelemetryAttribute.GenAiUsageCacheCreationInputTokens]: {
    producer: "future GenAI cache-token producers",
    sourceField: "cacheCreationInputTokens",
    reason:
      "Cache-token fields are ClosedLoop compatibility attributes unless the pinned OTel JS package exports them.",
  },
  [TelemetryAttribute.GenAiUsageCacheReadInputTokens]: {
    producer: "future GenAI cache-token producers",
    sourceField: "cacheReadInputTokens",
    reason:
      "Cache-token fields are ClosedLoop compatibility attributes unless the pinned OTel JS package exports them.",
  },
  [TelemetryAttribute.SyncEvent]: {
    producer:
      "apps/desktop/src/main/agent-session-sync-service.ts (sync subsystem instrumentation, FEA-1995)",
    sourceField: "syncEvent",
    reason:
      "Sync event names are ClosedLoop transport-health concepts with no pinned OTel semantic convention equivalent.",
  },
  [TelemetryAttribute.SyncOutcome]: {
    producer:
      "apps/desktop/src/main/agent-session-sync-service.ts (sync subsystem instrumentation, FEA-1995)",
    sourceField: "outcome",
    reason:
      "Sync outcome values are ClosedLoop transport-health concepts with no pinned OTel semantic convention equivalent.",
  },
  [TelemetryAttribute.SyncPayloadBytes]: {
    producer:
      "apps/desktop/src/main/agent-session-sync-service.ts (sync subsystem instrumentation, FEA-1995)",
    sourceField: "payloadBytes",
    reason:
      "Sync payload byte counts are ClosedLoop transport-health concepts with no pinned OTel semantic convention equivalent.",
  },
  [TelemetryAttribute.SyncLatencyMs]: {
    producer:
      "apps/desktop/src/main/agent-session-sync-service.ts (sync subsystem instrumentation, FEA-1995)",
    sourceField: "latencyMs",
    reason:
      "Sync latency as an attribute is a ClosedLoop transport-health concept with no pinned OTel semantic convention equivalent.",
  },
  [TelemetryAttribute.GenAiCostUsage]: {
    producer:
      "apps/desktop in-process OTLP receiver (harness cost events, PRD-468 FEA-1843)",
    sourceField: "costUsd",
    reason:
      "Per-call USD cost has no pinned OTel semantic convention; it remains a ClosedLoop compatibility field until OTel owns a GenAI cost attribute.",
  },
  [TelemetryAttribute.GenAiPermissionDecision]: {
    producer:
      "apps/desktop in-process OTLP receiver (harness permission events, PRD-468 FEA-1843)",
    sourceField: "permissionDecision",
    reason:
      "Harness permission decisions have no pinned OTel semantic convention equivalent and stay ClosedLoop compatibility fields.",
  },
  [TelemetryAttribute.GenAiPermissionSource]: {
    producer:
      "apps/desktop in-process OTLP receiver (harness permission events, PRD-468 FEA-1843)",
    sourceField: "permissionSource",
    reason:
      "Harness permission sources (FR-020 closed set) have no pinned OTel semantic convention equivalent and stay ClosedLoop compatibility fields.",
  },
  [TelemetryAttribute.HarnessName]: {
    producer: "every harness emitter (PRD-468 multi-harness discriminator)",
    sourceField: "harnessName",
    reason:
      "Runtime-tool discriminator identifying the producing harness (claude/codex/cursor/copilot/opencode). Distinct from the CLOTS agent.name logical-actor attribute; no pinned OTel semantic convention owns it, so it stays a ClosedLoop compatibility field.",
  },
} as const satisfies Record<
  ClosedLoopCompatibilityAttribute,
  { producer: string; sourceField: string; reason: string }
>;

/** Attribute ownership lookup used by schema and compatibility tests. */
export const TelemetryAttributeOwnershipByName = {
  [TelemetryAttribute.ServiceName]: TelemetryAttributeOwnership.Otel,
  [TelemetryAttribute.ServiceVersion]: TelemetryAttributeOwnership.Otel,
  [TelemetryAttribute.AppInstallationId]: TelemetryAttributeOwnership.Otel,
  [TelemetryAttribute.DeploymentEnvironmentName]:
    TelemetryAttributeOwnership.Otel,
  [TelemetryAttribute.ExceptionType]: TelemetryAttributeOwnership.Otel,
  [TelemetryAttribute.ExceptionMessage]: TelemetryAttributeOwnership.Otel,
  [TelemetryAttribute.ExceptionStacktrace]: TelemetryAttributeOwnership.Otel,
  [TelemetryAttribute.AppExceptionOrigin]:
    TelemetryAttributeOwnership.ClosedLoopCompatibility,
  [TelemetryAttribute.AppOperatingMode]:
    TelemetryAttributeOwnership.ClosedLoopCompatibility,
  [TelemetryAttribute.AppLifecycleEvent]:
    TelemetryAttributeOwnership.ClosedLoopCompatibility,
  [TelemetryAttribute.HttpRequestMethod]: TelemetryAttributeOwnership.Otel,
  [TelemetryAttribute.HttpResponseStatusCode]: TelemetryAttributeOwnership.Otel,
  [TelemetryAttribute.UrlPath]: TelemetryAttributeOwnership.Otel,
  [TelemetryAttribute.DurationMs]:
    TelemetryAttributeOwnership.ClosedLoopCompatibility,
  [TelemetryAttribute.CodeFunctionName]: TelemetryAttributeOwnership.Otel,
  [TelemetryAttribute.CodeFilePath]: TelemetryAttributeOwnership.Otel,
  [TelemetryAttribute.CodeLineNumber]: TelemetryAttributeOwnership.Otel,
  [TelemetryAttribute.CodeColumnNumber]: TelemetryAttributeOwnership.Otel,
  [TelemetryAttribute.ErrorType]: TelemetryAttributeOwnership.Otel,
  [TelemetryAttribute.GenAiUsageInputTokens]: TelemetryAttributeOwnership.Otel,
  [TelemetryAttribute.GenAiUsageOutputTokens]: TelemetryAttributeOwnership.Otel,
  [TelemetryAttribute.GenAiRequestModel]: TelemetryAttributeOwnership.Otel,
  [TelemetryAttribute.GenAiResponseId]: TelemetryAttributeOwnership.Otel,
  [TelemetryAttribute.GenAiUsageCacheCreationInputTokens]:
    TelemetryAttributeOwnership.ClosedLoopCompatibility,
  [TelemetryAttribute.GenAiUsageCacheReadInputTokens]:
    TelemetryAttributeOwnership.ClosedLoopCompatibility,
  [TelemetryAttribute.SyncEvent]:
    TelemetryAttributeOwnership.ClosedLoopCompatibility,
  [TelemetryAttribute.SyncOutcome]:
    TelemetryAttributeOwnership.ClosedLoopCompatibility,
  [TelemetryAttribute.SyncPayloadBytes]:
    TelemetryAttributeOwnership.ClosedLoopCompatibility,
  [TelemetryAttribute.SyncLatencyMs]:
    TelemetryAttributeOwnership.ClosedLoopCompatibility,
  [TelemetryAttribute.GenAiCostUsage]:
    TelemetryAttributeOwnership.ClosedLoopCompatibility,
  [TelemetryAttribute.GenAiPermissionDecision]:
    TelemetryAttributeOwnership.ClosedLoopCompatibility,
  [TelemetryAttribute.GenAiPermissionSource]:
    TelemetryAttributeOwnership.ClosedLoopCompatibility,
  [TelemetryAttribute.HarnessName]:
    TelemetryAttributeOwnership.ClosedLoopCompatibility,
} as const satisfies Record<
  TelemetryAttributeName,
  TelemetryAttributeOwnership
>;

/** Deprecated code attribute aliases accepted only by compatibility checks. */
export const DeprecatedCodeTelemetryAttributes = {
  CodeFunction: "code.function",
  CodeFilepath: "code.filepath",
  CodeLineno: "code.lineno",
  CodeColumn: "code.column",
  CodeNamespace: "code.namespace",
} as const;

/** Literal union of deprecated code attribute aliases. */
export type DeprecatedCodeTelemetryAttribute =
  (typeof DeprecatedCodeTelemetryAttributes)[keyof typeof DeprecatedCodeTelemetryAttributes];
