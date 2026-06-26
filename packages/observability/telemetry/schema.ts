import { LoopCommand } from "@closedloop-ai/loops-api/commands";
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
  DesktopShutdownFailed: "desktop.shutdown_failed",
  DesktopSupportUpload: "desktop.support_upload",
  PreflightBinaryNotFound: "preflight.binary_not_found",
  PreflightScriptNotFound: "preflight.script_not_found",
  PreflightSpawnFailed: "preflight.spawn_failed",
  ElectronUpdateInitiated: "electron_update.initiated",
  // ElectronUpdateSucceeded is emitted by Desktop update producers in apps/desktop.
  ElectronUpdateSucceeded: "electron_update.succeeded",
  // ElectronUpdateFailed is emitted by Desktop update producers in apps/desktop.
  ElectronUpdateFailed: "electron_update.failed",
  PluginUpdateAttempted: "plugin_update.attempted",
  PluginUpdateSucceeded: "plugin_update.succeeded",
  PluginUpdateFailed: "plugin_update.failed",
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
  // FEA-1969 — desktop genai-prices could not price a model's token usage.
  TokenCostPricingMiss: "token_cost.pricing_miss",
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

export const DesktopUpdateTrigger = {
  Unknown: "unknown",
  UpdaterError: "updater-error",
  CheckForUpdates: "check-for-updates",
  ManualCheck: "manual-check",
  ApplyBeforeDownloaded: "apply-before-downloaded",
  RendererApplyUpdate: "renderer-apply-update",
} as const;

export type DesktopUpdateTrigger =
  (typeof DesktopUpdateTrigger)[keyof typeof DesktopUpdateTrigger];

export const DesktopShutdownTrigger = {
  Unknown: "unknown",
  BeforeQuit: "before-quit",
  ShutdownSequence: "shutdown-sequence",
  ShutdownRejected: "shutdown-rejected",
  OuterHardExit: "outer-hard-exit",
} as const;

export type DesktopShutdownTrigger =
  (typeof DesktopShutdownTrigger)[keyof typeof DesktopShutdownTrigger];

function objectValues<T extends Record<string, string>>(values: T) {
  return new Set(Object.values(values));
}

/**
 * Preserve desktop-originated telemetry across version skew by mapping newer
 * wire strings to a bounded generic value instead of rejecting the whole event.
 * Non-string values remain invalid.
 */
function tolerantDesktopTelemetryValue<
  T extends { Unknown: string } & Record<string, string>,
>(values: T) {
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
  surface: tolerantDesktopTelemetryValue(OutboundNetworkSurface),
  decision: tolerantDesktopTelemetryValue(OutboundNetworkDecision),
  reason: tolerantDesktopTelemetryValue(OutboundNetworkDecisionReason),
  destinationClass: tolerantDesktopTelemetryValue(
    OutboundNetworkDestinationClass
  ),
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
  reason: tolerantDesktopTelemetryValue(SupportUploadReason).optional(),
  uploadedCount: z.number().int().nonnegative().optional(),
  durationMs: z.number().int().nonnegative().optional(),
});

const desktopUpdateDiagnosticsSchema = z.object({
  trigger: tolerantDesktopTelemetryValue(DesktopUpdateTrigger),
  status: z.string().max(64).optional(),
  version: z.string().max(64).optional(),
  percent: z.number().min(0).max(100).optional(),
  error: z.string().max(512).optional(),
  downloaded: z.boolean().optional(),
  readyToInstall: z.boolean().optional(),
});

const desktopShutdownDiagnosticsSchema = z.object({
  trigger: tolerantDesktopTelemetryValue(DesktopShutdownTrigger),
  result: z.enum(["timed_out", "failed"]).optional(),
  phase: z.string().max(128).optional(),
  duringUpdate: z.boolean().optional(),
  outerHardExit: z.boolean().optional(),
  elapsedMs: z.number().int().nonnegative().optional(),
  error: z.string().max(512).optional(),
});

// ---------------------------------------------------------------------------
// LoopPerfEventDiagnostics — permissive passthrough for loop.perf.* categories
// ---------------------------------------------------------------------------
// The relay forwards `loopPerf` payloads to Datadog opaquely so version skew
// between desktop producers and the relay never drops observability data
// (PRD-254 §FR-6 fail-open, producer-additivity rollout property). Field-level
// validation is owned by the producer schema in apps/desktop.
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

export const KNOWN_LOOP_COMMANDS: ReadonlySet<string> = new Set(
  Object.values(LoopCommand)
);

export const LOOP_PERF_RATE_LIMIT_BYPASS_EVENTS: ReadonlyMap<string, string> =
  new Map([
    // Relay rate-limit bypass uses this map as its cheap category precheck.
    // Add future loop.perf.* categories here with KNOWN_LOOP_PERF_EVENTS so
    // they use the loopPerf-specific cap instead of the generic relay limiter.
    [TelemetryCategory.LoopPerfRun, "run"],
    [TelemetryCategory.LoopPerfPhase, "phase"],
    [TelemetryCategory.LoopPerfIteration, "iteration"],
    [TelemetryCategory.LoopPerfPipelineStep, "pipeline_step"],
    [TelemetryCategory.LoopPerfAgent, "agent"],
    [TelemetryCategory.LoopPerfTool, "tool"],
    [TelemetryCategory.LoopPerfSkill, "skill"],
    [TelemetryCategory.LoopPerfSpawn, "spawn"],
    [TelemetryCategory.LoopPerfParseFailure, "parse_failure"],
  ]);

export const loopPerfEventDiagnosticsSchema = z
  .object({ event: z.string().optional() })
  .passthrough();

export type LoopPerfEventDiagnostics = z.infer<
  typeof loopPerfEventDiagnosticsSchema
>;

// ---------------------------------------------------------------------------
// LifecycleDiagnostics — permissive passthrough for job.* lifecycle attribution
// ---------------------------------------------------------------------------
// Accepts `diagnostics.lifecycle.command` from desktop producers on `job.*`
// events. Known values are enumerated in `KNOWN_LOOP_COMMANDS`; unknown strings
// are accepted via `.passthrough()` to preserve producer-additivity across
// version skew (AC-002, AC-003). Field-level validation of canonical values is
// owned by the producer schema in apps/desktop.
//
// `command` is `.optional()` so payloads without the field also validate
// (back-compat, AC-001). Unknown sibling fields under `lifecycle` survive
// parsing and reach Datadog via `.passthrough()` (AC-003).

export const lifecycleDiagnosticsSchema = z
  .object({ command: z.string().optional() })
  .passthrough();

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
  desktopUpdate: desktopUpdateDiagnosticsSchema.optional(),
  desktopShutdown: desktopShutdownDiagnosticsSchema.optional(),
  pluginUpdate: z
    .object({
      pluginIds: z.array(z.string().max(80)).max(6),
      versionsBefore: z.record(z.string().max(80), z.string().max(64)),
      versionsAfter: z.record(z.string().max(80), z.string().max(64)),
      outcomes: z.record(
        z.string().max(80),
        z.enum(["success", "failed", "timeout", "skipped"])
      ),
      durationMs: z.number().nonnegative(),
      command: z.literal("claude plugin update"),
      scope: z.literal("user"),
      exitCode: z.number().optional(),
      failureReason: z
        .enum([
          "command_failed",
          "timeout",
          "still_outdated",
          "cli_unavailable",
          "manifest_unavailable",
          "unknown",
        ])
        .optional(),
      stderrTail: z.string().max(512).optional(),
    })
    .strip()
    .optional(),
  outboundNetwork: outboundNetworkDiagnosticsSchema.optional(),
  supportUpload: supportUploadDiagnosticsSchema.optional(),
  loopPerf: loopPerfEventDiagnosticsSchema.optional(),
  lifecycle: lifecycleDiagnosticsSchema.optional(),
  // FEA-1969 — token-cost pricing miss. Typed (not `extra`) so the fields
  // survive validation: the top-level diagnostics object strips unknown keys,
  // so only declared fields reach Datadog.
  tokenCostPricingMiss: z
    .object({
      model: z.string().max(120),
      reason: z.enum(["unknown_model", "no_match", "compute_error"]),
      surface: z.enum([
        "synced_session",
        "sync_resolver",
        "branch_projection",
        "trace_activity",
        "imported_token_costs",
      ]),
      sessionId: z.string().max(200).optional(),
    })
    .optional(),
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

export function isLoopPerfTelemetryRateLimitBypass(
  payload: unknown,
  expectedComputeTargetId: string
): boolean {
  if (typeof payload !== "object" || payload === null) {
    return false;
  }

  const category = (payload as { category?: unknown }).category;
  if (
    typeof category !== "string" ||
    !LOOP_PERF_RATE_LIMIT_BYPASS_EVENTS.has(category)
  ) {
    return false;
  }

  const parsed = desktopTelemetryEventInputSchema.safeParse(payload);
  if (!parsed.success) {
    return false;
  }

  if (parsed.data.trace.computeTargetId !== expectedComputeTargetId) {
    return false;
  }

  const expectedEvent = LOOP_PERF_RATE_LIMIT_BYPASS_EVENTS.get(
    parsed.data.category
  );
  if (expectedEvent === undefined) {
    return false;
  }

  return parsed.data.diagnostics?.loopPerf?.event === expectedEvent;
}
