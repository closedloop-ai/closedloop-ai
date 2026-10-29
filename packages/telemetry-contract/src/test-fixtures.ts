import { TelemetryAttribute } from "./attributes";
import { TelemetrySchemaName } from "./schema-name";
import { SpanKind, SpanStatusCode } from "./span";

/** Shared valid App fixture used by tests and package smoke scripts. */
export function appPayload(overrides: Record<string, unknown> = {}) {
  return {
    [TelemetryAttribute.AppInstallationId]: "install_0123456789abcdef",
    [TelemetryAttribute.DeploymentEnvironmentName]: "desktop-local",
    [TelemetryAttribute.AppOperatingMode]: "single_player",
    [TelemetryAttribute.AppLifecycleEvent]: "start",
    ...overrides,
  };
}

/** Shared valid span fixture used by tests and package smoke scripts. */
export function spanPayload(overrides: Record<string, unknown> = {}) {
  return {
    [TelemetryAttribute.HttpRequestMethod]: "GET",
    [TelemetryAttribute.HttpResponseStatusCode]: 200,
    [TelemetryAttribute.UrlPath]: "/ok",
    [TelemetryAttribute.DurationMs]: 1,
    ...overrides,
  };
}

/** Shared valid span envelope fixture used by tests and package smoke scripts. */
export function spanEnvelopePayload(overrides: Record<string, unknown> = {}) {
  return {
    trace_id: "0123456789abcdef0123456789abcdef",
    span_id: "0123456789abcdef",
    name: "http.request",
    kind: SpanKind.Internal,
    status: {
      code: SpanStatusCode.Ok,
    },
    duration_ms: 1,
    schema_name: TelemetrySchemaName.Span,
    attributes: spanPayload(),
    ...overrides,
  };
}

/** Shared valid GenAI fixture used by tests and package smoke scripts. */
export function genAiPayload(overrides: Record<string, unknown> = {}) {
  return {
    [TelemetryAttribute.GenAiRequestModel]: "gpt-5",
    ...overrides,
  };
}

/** Shared valid Sync fixture used by tests and package smoke scripts. */
export function syncPayload(overrides: Record<string, unknown> = {}) {
  return {
    [TelemetryAttribute.SyncEvent]: "batch",
    [TelemetryAttribute.SyncOutcome]: "success",
    [TelemetryAttribute.SyncPayloadBytes]: 128,
    [TelemetryAttribute.SyncLatencyMs]: 12.5,
    ...overrides,
  };
}

/** Shared valid Permission fixture used by tests and package smoke scripts. */
export function permissionPayload(overrides: Record<string, unknown> = {}) {
  return {
    [TelemetryAttribute.GenAiPermissionDecision]: "allow",
    [TelemetryAttribute.GenAiPermissionSource]: "config",
    ...overrides,
  };
}

/** Shared valid IPC perf fixture used by tests and package smoke scripts. */
export function ipcPayload(overrides: Record<string, unknown> = {}) {
  return {
    ...ipcHandlerMeasuredDimensions(),
    [TelemetryAttribute.IpcSessionCount]: 1280,
    ...overrides,
  };
}

/** The IPC perf dimensions the handler itself measures; the COUNT is separate. */
function ipcHandlerMeasuredDimensions() {
  return {
    [TelemetryAttribute.IpcOperation]: "list",
    [TelemetryAttribute.DurationMs]: 42,
    [TelemetryAttribute.IpcMatchedCount]: 250,
    [TelemetryAttribute.IpcPayloadBytes]: 2048,
    [TelemetryAttribute.IpcQueryExecution]: "hydrated_fallback",
    [TelemetryAttribute.IpcQuerySource]: "canonical",
    [TelemetryAttribute.IpcResultCount]: 25,
    [TelemetryAttribute.IpcScannedCount]: 500,
  };
}

/**
 * ISS-8773: the event a distressed db-host produces — the follow-up
 * `session_count` COUNT failed alongside the handler, so the dimension is
 * omitted rather than fabricated, and `error.type` is what the event carries.
 */
export function ipcPayloadWithoutSessionCount(
  overrides: Record<string, unknown> = {}
) {
  return {
    ...ipcHandlerMeasuredDimensions(),
    ...overrides,
  };
}
