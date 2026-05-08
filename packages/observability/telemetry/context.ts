import { z } from "zod";

import type { TelemetryTraceContext } from "./schema";

// ---------------------------------------------------------------------------
// Server version validation — semver or max-40-char safe alphanumeric string.
// No path separators or whitespace allowed.
// ---------------------------------------------------------------------------

const SEMVER_RE = /^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?(?:\+[a-zA-Z0-9.-]+)?$/;
const SAFE_VERSION_RE = /^[a-zA-Z0-9.-]{1,40}$/;

const serverVersionSchema = z
  .string()
  .refine(
    (v: string) => SEMVER_RE.test(v) || SAFE_VERSION_RE.test(v),
    "serverVersion must be semver or a max-40-char alphanumeric/dot/dash string with no path separators or whitespace"
  );

// ---------------------------------------------------------------------------
// Environment resolution
// ---------------------------------------------------------------------------

function resolveEnvironment(): string {
  return (
    process.env.NODE_ENV ??
    process.env.RELAY_ENV ??
    process.env.CLOSEDLOOP_ENVIRONMENT ??
    "unknown"
  );
}

export function resolveServerVersion(): string {
  return (
    process.env.RELEASE_VERSION ?? process.env.npm_package_version ?? "unknown"
  );
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function buildTelemetryTraceContext(
  overrides: Partial<TelemetryTraceContext>
): TelemetryTraceContext {
  const rawVersion = overrides.serverVersion ?? resolveServerVersion();

  const parseResult = serverVersionSchema.safeParse(rawVersion);
  const serverVersion = parseResult.success ? rawVersion : "unknown";

  return {
    commandId: overrides.commandId ?? "",
    operationId: overrides.operationId ?? "",
    computeTargetId: overrides.computeTargetId ?? "",
    gatewaySessionId:
      overrides.gatewaySessionId ?? "00000000-0000-0000-0000-000000000000",
    schemaVersion: overrides.schemaVersion ?? "1",
    environment: overrides.environment ?? resolveEnvironment(),
    serverVersion,
    ...(overrides.loopSessionId !== undefined && {
      loopSessionId: overrides.loopSessionId,
    }),
    ...(overrides.loopId !== undefined && { loopId: overrides.loopId }),
    ...(overrides.jobId !== undefined && { jobId: overrides.jobId }),
    ...(overrides.requestId !== undefined && {
      requestId: overrides.requestId,
    }),
    ...(overrides.pluginVersion !== undefined && {
      pluginVersion: overrides.pluginVersion,
    }),
    ...(overrides.desktopClientVersion !== undefined && {
      desktopClientVersion: overrides.desktopClientVersion,
    }),
    ...(overrides.gatewayProtocolVersion !== undefined && {
      gatewayProtocolVersion: overrides.gatewayProtocolVersion,
    }),
  };
}
