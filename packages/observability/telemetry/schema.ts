import { z } from "zod";

// ---------------------------------------------------------------------------
// TelemetryCategory — grouped by origin
// ---------------------------------------------------------------------------

export const TelemetryCategory = {
  // Server-side categories
  CommandQueued: "command.queued",
  CommandDispatched: "command.dispatched",
  CommandAcknowledged: "command.acknowledged",
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
  DesktopOutboundNetworkDecision: "desktop.outbound_network_decision",
  DesktopSupportUpload: "desktop.support_upload",
  PreflightBinaryNotFound: "preflight.binary_not_found",
  PreflightScriptNotFound: "preflight.script_not_found",
  PreflightSpawnFailed: "preflight.spawn_failed",
  ElectronUpdateInitiated: "electron_update.initiated",
  // Q-001: ElectronUpdateSucceeded requires cross-repo coordination with closedloop-electron
  ElectronUpdateSucceeded: "electron_update.succeeded",
  // Q-001: ElectronUpdateFailed requires cross-repo coordination with closedloop-electron
  ElectronUpdateFailed: "electron_update.failed",
  // Desktop onboarding popup events (AC-001)
  OnboardingPopupShown: "onboarding.popup_shown",
  OnboardingPopupCtaClicked: "onboarding.popup_cta_clicked",
  OnboardingPopupDismissedSession: "onboarding.popup_dismissed_session",
  OnboardingPopupDismissedPermanent: "onboarding.popup_dismissed_permanent",
  OnboardingPopupSuppressedAuto: "onboarding.popup_suppressed_auto",
  // PRD-254 — loop.perf.* telemetry categories (one outer category per
  // perf.jsonl event type plus a parse-failure warning channel).
  LoopPerfRun: "loop.perf.run",
  LoopPerfPhase: "loop.perf.phase",
  LoopPerfIteration: "loop.perf.iteration",
  LoopPerfPipelineStep: "loop.perf.pipeline_step",
  LoopPerfAgent: "loop.perf.agent",
  LoopPerfTool: "loop.perf.tool",
  LoopPerfSkill: "loop.perf.skill",
  LoopPerfSpawn: "loop.perf.spawn",
  LoopPerfParseFailure: "loop.perf.parse_failure",
  LoopPerfUnknownEventVariant: "loop.perf.unknown_event_variant",
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

export const OutboundNetworkSurface = {
  Unknown: "unknown",
  LoopAttachmentDownload: "loop_attachment_download",
  LoopSupportUpload: "loop_support_upload",
  DeployHealthCheck: "deploy_health_check",
} as const;

export type OutboundNetworkSurface =
  (typeof OutboundNetworkSurface)[keyof typeof OutboundNetworkSurface];

export const OutboundNetworkDecision = {
  Unknown: "unknown",
  Allowed: "allowed",
  Denied: "denied",
} as const;

export type OutboundNetworkDecision =
  (typeof OutboundNetworkDecision)[keyof typeof OutboundNetworkDecision];

export const OutboundNetworkDestinationClass = {
  Unknown: "unknown",
  External: "external",
  Invalid: "invalid",
  IpLiteral: "ip_literal",
  LinkLocal: "link_local",
  Loopback: "loopback",
  Metadata: "metadata",
  Private: "private",
  S3PathStyle: "s3_path_style",
  S3VirtualHosted: "s3_virtual_hosted",
} as const;

export type OutboundNetworkDestinationClass =
  (typeof OutboundNetworkDestinationClass)[keyof typeof OutboundNetworkDestinationClass];

export const OutboundNetworkDecisionReason = {
  Unknown: "unknown",
  Allowed: "allowed",
  AttachmentHostNotAllowed: "attachment_host_not_allowed",
  CredentialedUrl: "credentialed_url",
  DeployHostNotAllowed: "deploy_host_not_allowed",
  InvalidUrl: "invalid_url",
  IpLiteralNotAllowed: "ip_literal_not_allowed",
  LinkLocalAddressNotAllowed: "link_local_address_not_allowed",
  MetadataAddressNotAllowed: "metadata_address_not_allowed",
  PathStyleS3NotAllowed: "path_style_s3_not_allowed",
  PrivateAddressNotAllowed: "private_address_not_allowed",
  UnsupportedProtocol: "unsupported_protocol",
} as const;

export type OutboundNetworkDecisionReason =
  (typeof OutboundNetworkDecisionReason)[keyof typeof OutboundNetworkDecisionReason];

export const SupportUploadReason = {
  Unknown: "unknown",
  AlreadyUploaded: "already_uploaded",
  MissingS3StateKey: "missing_s3_state_key",
  NoUploadableFiles: "no_uploadable_files",
  UploadUrlHttpError: "upload_url_http_error",
  UploadUrlMalformedResponse: "upload_url_malformed_response",
  UploadUrlSuccessFalse: "upload_url_success_false",
  UploadUrlMissingUrl: "upload_url_missing_url",
  UploadUrlRequestFailed: "upload_url_request_failed",
  PutUrlDenied: "put_url_denied",
  PutHttpError: "put_http_error",
  PutRequestFailed: "put_request_failed",
  EventPostFailed: "event_post_failed",
} as const;

export type SupportUploadReason =
  (typeof SupportUploadReason)[keyof typeof SupportUploadReason];

function objectValues<T extends Record<string, string>>(values: T) {
  return new Set(Object.values(values));
}

/**
 * Preserve desktop-originated outbound telemetry across version skew by mapping
 * newer classification strings to a bounded generic value instead of rejecting
 * the whole event. Non-string values remain invalid.
 */
function tolerantOutboundValue<T extends Record<string, string>>(values: T) {
  const knownValues = objectValues(values);
  return z.preprocess((value) => {
    if (typeof value !== "string") {
      return value;
    }
    return knownValues.has(value) ? value : values.Unknown;
  }, z.enum(values));
}

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

const outboundNetworkDiagnosticsSchema = z.object({
  surface: tolerantOutboundValue(OutboundNetworkSurface),
  decision: tolerantOutboundValue(OutboundNetworkDecision),
  reason: tolerantOutboundValue(OutboundNetworkDecisionReason),
  destinationClass: tolerantOutboundValue(OutboundNetworkDestinationClass),
  protocol: z.string().optional(),
  hostname: z.string().optional(),
  port: z.string().optional(),
  statusCode: z.number().int().nonnegative().optional(),
});

const supportUploadDiagnosticsSchema = z.object({
  outcome: z.enum(["started", "skipped", "succeeded", "failed"]),
  loopId: z.string().optional(),
  s3StateKeySuffix: z.string().optional(),
  attemptedLogicalNames: z.array(z.string()).max(4).optional(),
  attemptedUploadedNames: z.array(z.string()).max(4).optional(),
  reason: tolerantOutboundValue(SupportUploadReason).optional(),
  uploadedCount: z.number().int().nonnegative().optional(),
  durationMs: z.number().int().nonnegative().optional(),
});

// ---------------------------------------------------------------------------
// LoopPerfEventDiagnostics — permissive passthrough for loop.perf.* categories
// ---------------------------------------------------------------------------
// The relay forwards `loopPerf` payloads to Datadog opaquely so version skew
// between desktop producers and the relay never drops observability data
// (PRD-254 §FR-6 fail-open, producer-additivity rollout property). Field-level
// validation is owned by the producer schema in closedloop-electron.
//
// Drift detection: the handler emits a `loop.perf.unknown_event_variant`
// warning when the inner `event` value falls outside `KNOWN_LOOP_PERF_EVENTS`
// (or is missing entirely), while still forwarding the payload — this is how
// desktop-version skew becomes observable rather than silent or breaking
// (e.g. legacy `post_loop_review` / `post_loop_fix` arrivals, or a future
// desktop build that renames the discriminator).
//
// `event` is `.optional()` so missing-discriminator payloads also fail open
// rather than tripping envelope-level validation; the handler's drift check
// catches the absent case and emits the same warning channel.
//
// Producer-side wire-format invariants (informational; not enforced here):
// - Optional fields are absent (omitted), not `null`. Exception: `tool` events
//   may carry `endedAt`/`durationS`/`ok` as `null` as the in-flight sentinel
//   for orphan-tool reconciliation at end-of-loop.
// - `pipeline_step.step` is a number, not an integer (producer emits 8.5 for
//   the synthetic `write_merged_patterns` step).

export const KNOWN_LOOP_PERF_EVENTS: ReadonlySet<string> = new Set([
  "run",
  "phase",
  "iteration",
  "pipeline_step",
  "agent",
  "tool",
  "skill",
  "spawn",
  "parse_failure",
]);

export const loopPerfEventDiagnosticsSchema = z
  .object({ event: z.string().optional() })
  .passthrough();

export type LoopPerfEventDiagnostics = z.infer<
  typeof loopPerfEventDiagnosticsSchema
>;

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
  outboundNetwork: outboundNetworkDiagnosticsSchema.optional(),
  supportUpload: supportUploadDiagnosticsSchema.optional(),
  loopPerf: loopPerfEventDiagnosticsSchema.optional(),
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
