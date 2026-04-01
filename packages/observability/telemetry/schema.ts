import { z } from "zod";

// ---------------------------------------------------------------------------
// TelemetryCategory — grouped by origin
// ---------------------------------------------------------------------------

export const TelemetryCategory = {
  // Server-side categories
  CommandQueued: "command.queued",
  CommandDispatched: "command.dispatched",
  CommandAcknowledged: "command.acknowledged",
  CommandStreamingStarted: "command.streaming_started",
  CommandCompleted: "command.completed",
  CommandFailed: "command.failed",
  CommandTimedOut: "command.timed_out",
  CommandReplayed: "command.replayed",
  ConnectionSocketAccepted: "connection.socket_accepted",
  ConnectionRegistered: "connection.registered",
  ConnectionReconnecting: "connection.reconnecting",
  ConnectionResumed: "connection.resumed",
  ConnectionDegraded: "connection.degraded",
  ConnectionDisconnected: "connection.disconnected",
  ConnectionStaleHeartbeat: "connection.stale_heartbeat",
  TelemetryValidationFailed: "telemetry.validation_failed",
  // Desktop-side categories
  JobStarted: "job.started",
  JobCompleted: "job.completed",
  JobFailed: "job.failed",
  CommandTimeout: "command.timeout",
  CommandCancelled: "command.cancelled",
  CommandGatewayError: "command.gateway_error",
  PreflightBinaryNotFound: "preflight.binary_not_found",
  PreflightScriptNotFound: "preflight.script_not_found",
  PreflightSpawnFailed: "preflight.spawn_failed",
} as const;

export type TelemetryCategory =
  (typeof TelemetryCategory)[keyof typeof TelemetryCategory];

// ---------------------------------------------------------------------------
// TelemetrySeverity
// ---------------------------------------------------------------------------

export const TelemetrySeverity = {
  Info: "info",
  Warn: "warn",
  Error: "error",
} as const;

export type TelemetrySeverity =
  (typeof TelemetrySeverity)[keyof typeof TelemetrySeverity];

// ---------------------------------------------------------------------------
// ErrorClass
// ---------------------------------------------------------------------------

export const ErrorClass = {
  Connection: "connection",
  Protocol: "protocol",
  Approval: "approval",
  Sandbox: "sandbox",
  Execution: "execution",
  Deployment: "deployment",
} as const;

export type ErrorClass = (typeof ErrorClass)[keyof typeof ErrorClass];

// ---------------------------------------------------------------------------
// TelemetryTraceContext — shared trace fields (no PII: no machineName, no userId)
// ---------------------------------------------------------------------------

export const telemetryTraceContextSchema = z.object({
  commandId: z.string(),
  operationId: z.string(),
  computeTargetId: z.string(),
  gatewaySessionId: z.uuid(),
  loopSessionId: z.uuid().optional(),
  loopId: z.string().optional(),
  jobId: z.string().optional(),
  requestId: z.string().optional(),
  environment: z.string().optional(),
  serverVersion: z.string().optional(),
  pluginVersion: z.string().optional(),
  schemaVersion: z.string(),
});

export type TelemetryTraceContext = z.infer<typeof telemetryTraceContextSchema>;

// ---------------------------------------------------------------------------
// TelemetryDiagnostics
// ---------------------------------------------------------------------------

export const telemetryDiagnosticsSchema = z.object({
  logTail: z.string().optional(),
  exitCode: z.number().optional(),
  tokenUsage: z
    .object({
      inputTokens: z.number(),
      outputTokens: z.number(),
    })
    .optional(),
});

export type TelemetryDiagnostics = z.infer<typeof telemetryDiagnosticsSchema>;

// ---------------------------------------------------------------------------
// DesktopTelemetryEvent — accepts Electron wire format and transforms
// trace.sessionId → loopSessionId
// ---------------------------------------------------------------------------

const desktopTelemetryEventInputSchema = z.object({
  schemaVersion: z.string(),
  category: z.string(),
  severity: z.string(),
  timestamp: z.string(),
  trace: z.object({
    commandId: z.string(),
    operationId: z.string(),
    computeTargetId: z.string(),
    gatewaySessionId: z.uuid().optional(),
    sessionId: z.uuid().optional(),
    loopId: z.string().optional(),
    jobId: z.string().optional(),
    requestId: z.string().optional(),
    environment: z.string().optional(),
    serverVersion: z.string().optional(),
    pluginVersion: z.string().optional(),
  }),
  diagnostics: telemetryDiagnosticsSchema.optional(),
  message: z.string().optional(),
  errorClass: z.string().optional(),
});

type DesktopTelemetryEventInput = z.infer<
  typeof desktopTelemetryEventInputSchema
>;

export const desktopTelemetryEventSchema =
  desktopTelemetryEventInputSchema.transform(
    (raw: DesktopTelemetryEventInput) => {
      const { sessionId, ...restTrace } = raw.trace;
      return {
        schemaVersion: raw.schemaVersion,
        category: raw.category,
        severity: raw.severity,
        timestamp: raw.timestamp,
        trace: { ...restTrace, loopSessionId: sessionId },
        diagnostics: raw.diagnostics,
        message: raw.message,
        errorClass: raw.errorClass,
      };
    }
  );

export type DesktopTelemetryEvent = z.infer<typeof desktopTelemetryEventSchema>;
