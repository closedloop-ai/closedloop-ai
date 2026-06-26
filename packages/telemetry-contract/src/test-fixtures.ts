import { TelemetryAttribute } from "./attributes";

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
