import { z } from "zod";

// ---------------------------------------------------------------------------
// TelemetryCategory — grouped by origin
// ---------------------------------------------------------------------------

export const TelemetryCategory = {
  // Server-side categories
  CommandQueued: "command.queued",
  CommandDispatched: "command.dispatched",
  CommandAcknowledged: "command.acknowledged",
  /** @deprecated No active emission site. Removal tracked in FEA-535. */
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
  JobPlanSourceResolved: "job.plan_source_resolved",
  JobDecisionTableVerification: "job.decision_table_verification",
  JobCompleted: "job.completed",
  JobFailed: "job.failed",
  CommandTimeout: "command.timeout",
  CommandCancelled: "command.cancelled",
  CommandGatewayError: "command.gateway_error",
  PreflightBinaryNotFound: "preflight.binary_not_found",
  PreflightScriptNotFound: "preflight.script_not_found",
  PreflightSpawnFailed: "preflight.spawn_failed",
  ElectronUpdateInitiated: "electron_update.initiated",
  // Q-001: ElectronUpdateSucceeded requires cross-repo coordination with closedloop-electron
  ElectronUpdateSucceeded: "electron_update.succeeded",
  // Q-001: ElectronUpdateFailed requires cross-repo coordination with closedloop-electron
  ElectronUpdateFailed: "electron_update.failed",
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
  desktopClientVersion: z.string().optional(),
  gatewayProtocolVersion: z.string().optional(),
});

export type TelemetryTraceContext = z.infer<typeof telemetryTraceContextSchema>;

// ---------------------------------------------------------------------------
// TelemetryDiagnostics
// ---------------------------------------------------------------------------

// Desktop wire format — must not include server-only protocol fields.
// Desktop-originated telemetry is parsed against this schema; any server-only
// field (e.g. ackLatencyMs) carried in a desktop payload is stripped by Zod's
// default `.strip` behavior before reaching the log emitter.
const decisionTableVerificationDiagnosticsSchema = z.discriminatedUnion(
  "telemetryStatus",
  [
    z.object({
      telemetryStatus: z.literal("reported"),
      telemetryFilePath: z.string(),
      lineNumber: z.number().int().nonnegative(),
      timestamp: z.string(),
      workdir: z.string(),
      decisionTablePath: z.string(),
      finalStatus: z.enum([
        "aligned",
        "aligned_with_clarifications",
        "verification_failed",
      ]),
      iterations: z.number().int().nonnegative(),
      driftKindCounts: z.object({
        codeDrift: z.number().int().nonnegative(),
        testDrift: z.number().int().nonnegative(),
        planAmbiguity: z.number().int().nonnegative(),
      }),
      fixesAttempted: z.number().int().nonnegative(),
      parseFailures: z.number().int().nonnegative(),
      verifierInvocations: z.number().int().nonnegative(),
      phaseDurationMs: z.number().int().nonnegative(),
    }),
    z.object({
      telemetryStatus: z.literal("missing"),
      telemetryFilePath: z.string(),
      filePresent: z.boolean(),
      linesRead: z.number().int().nonnegative(),
      invalidLines: z.number().int().nonnegative(),
      missingReason: z.enum([
        "file_not_found",
        "empty",
        "no_current_run_records",
        "read_error",
      ]),
      sinceIso: z.string().optional(),
      readError: z.string().optional(),
    }),
  ]
);

const desktopTelemetryDiagnosticsSchema = z.object({
  logTail: z.string().optional(),
  exitCode: z.number().optional(),
  planSource: z
    .object({
      source: z.enum([
        "raw-artifact",
        "local-plan-json",
        "imported-plan-compat",
      ]),
      rawPlanPayload: z.boolean(),
      rawPlanAligned: z.boolean(),
      localPlanJsonPresent: z.boolean(),
      localPlanJsonAligned: z.boolean(),
      importedPlanFileStaged: z.boolean(),
      closedLoopPlanFileSet: z.boolean(),
      planArtifactContentLength: z.number(),
      rawPlanContentLength: z.number().nullable().optional(),
      planArtifactContentHash: z.string().nullable().optional(),
      rawPlanContentHash: z.string().nullable().optional(),
    })
    .optional(),
  tokenUsage: z
    .object({
      inputTokens: z.number(),
      outputTokens: z.number(),
      cacheCreationInputTokens: z.number().optional(),
      cacheReadInputTokens: z.number().optional(),
    })
    .optional(),
  stderrTail: z.string().optional(),
  exitSignal: z.string().optional(),
  elapsedMs: z.number().optional(),
  stdoutBytes: z.number().optional(),
  abortReason: z.string().optional(),
  diagnosticsVersion: z.number().optional(),
  decisionTableVerification:
    decisionTableVerificationDiagnosticsSchema.optional(),
  spawnMeta: z
    .object({
      command: z.string(),
      args: z.array(z.string()),
      cwd: z.string(),
      claudeVersion: z.string().optional(),
      binaryPath: z.string(),
      authFilesExist: z.boolean(),
      envSnapshot: z.record(z.string(), z.string()),
    })
    .optional(),
});

// Server-emission format — extends desktop with server-only fields.
// The schema split enforces the server-only invariant structurally, so the
// JSDoc is backed by parsing behavior rather than documentation alone.
export const telemetryDiagnosticsSchema =
  desktopTelemetryDiagnosticsSchema.extend({
    /** Server-only lifecycle-protocol field. Semantically scoped to CommandAcknowledged events; must not be set on other categories. Desktop wire parsing strips this field. */
    ackLatencyMs: z.number().optional(),
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
    desktopClientVersion: z.string().optional(),
    gatewayProtocolVersion: z.string().optional(),
  }),
  diagnostics: desktopTelemetryDiagnosticsSchema.optional(),
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
