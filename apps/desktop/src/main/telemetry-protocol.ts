import type { LoopCommand } from "@closedloop-ai/loops-api/commands";
import type { LoopHarness } from "@closedloop-ai/loops-api/desktop-request";
import type { TokenCostNotPricedReason } from "../shared/token-cost.js";
import type { ProtocolEnvelope } from "./cloud-protocol.js";

// Constants for log tail collection
export const TELEMETRY_LOG_TAIL_LINES = 50;
export const TELEMETRY_LOG_TAIL_MAX_BYTES = 32_768; // 32 KiB
export const TELEMETRY_MAX_FIELD_BYTES = 4096; // 4 KiB
export const STDERR_TAIL_MAX_BYTES = 4096; // 4 KiB
export const STDERR_TAIL_MAX_LINES = 50;

export type TelemetrySeverity = "info" | "warn" | "error";

export type TelemetryCategory =
  | "command.timeout"
  | "command.cancelled"
  | "command.gateway_error"
  | "desktop.outbound_network_decision"
  | "desktop.shutdown_failed"
  | "desktop.support_upload"
  | "electron_update.initiated"
  | "electron_update.failed"
  | "plugin_update.attempted"
  | "plugin_update.succeeded"
  | "plugin_update.failed"
  | "job.started"
  | "job.plan_source_resolved"
  | "job.decision_table_verification"
  | "job.completed"
  | "job.recovery.finalize_replayed"
  | "job.failed"
  | "job.cancelled"
  | "job.auth_challenge"
  | "preflight.binary_not_found"
  | "preflight.script_not_found"
  | "preflight.spawn_failed"
  | "connection.established"
  | "connection.reconnection_resumed"
  | "connection.degraded"
  | "connection.lost"
  | "desktop_pop.unavailable"
  | "onboarding.popup_shown"
  | "onboarding.popup_cta_clicked"
  | "onboarding.popup_dismissed_session"
  | "onboarding.popup_dismissed_permanent"
  | "onboarding.popup_suppressed_auto"
  | "command.initiated"
  | "command.started"
  | "command.completed"
  | "queue.stats_changed"
  | "healthcheck.failure_detected"
  | "healthcheck.recovered"
  | "healthcheck.failure_persistent"
  | "loop.perf.run"
  | "loop.perf.phase"
  | "loop.perf.iteration"
  | "loop.perf.pipeline_step"
  | "loop.perf.agent"
  | "loop.perf.tool"
  | "loop.perf.skill"
  | "loop.perf.spawn"
  | "loop.perf.parse_failure"
  | "loop.heartbeat.terminal_finalization_suppressed"
  | "token_cost.pricing_miss"
  // FEA-1999 — desktop SQLite store integrity-health signal. Four cadence
  // states mirror the healthcheck.* family: a failure is reported once on
  // detection, re-reported on a heartbeat while it persists, and a recovery /
  // first-healthy probe emits a clean signal.
  | "store.integrity.failure_detected"
  | "store.integrity.failure_persistent"
  | "store.integrity.recovered"
  | "store.integrity.healthy";

/**
 * Costing layer that observed an unpriced model (FEA-1969). SSOT for the
 * surface enum — the canonical Zod schema in
 * `@repo/observability/telemetry/schema` mirrors these values.
 */
export type TokenCostPricingMissSurface =
  | "synced_session"
  | "sync_resolver"
  | "branch_projection"
  | "trace_activity"
  | "imported_token_costs";

export type TokenCostPricingMissDiagnostics = {
  model: string;
  reason: TokenCostNotPricedReason;
  surface: TokenCostPricingMissSurface;
  sessionId?: string;
};

export type TelemetryTraceContext = {
  computeTargetId?: string;
  commandId?: string;
  operationId?: string;
  loopId?: string;
  jobId?: string;
  gatewaySessionId?: string;
  loopSessionId?: string;
  desktopClientVersion?: string;
};

export type ExecutePlanSource =
  | "raw-artifact"
  | "local-plan-json"
  | "imported-plan-compat";

export type ExecutePlanSourceDiagnostics = {
  source: ExecutePlanSource;
  rawPlanPayload: boolean;
  rawPlanAligned: boolean;
  localPlanJsonPresent: boolean;
  localPlanJsonAligned: boolean;
  importedPlanFileStaged: boolean;
  closedLoopPlanFileSet: boolean;
  planArtifactContentLength: number;
  rawPlanContentLength?: number | null;
  planArtifactContentHash?: string | null;
  rawPlanContentHash?: string | null;
};

export type DecisionTableVerificationFinalStatus =
  | "aligned"
  | "aligned_with_clarifications"
  | "verification_failed";

export type DecisionTableVerificationMissingReason =
  | "file_not_found"
  | "empty"
  | "no_current_run_records"
  | "read_error";

export type DecisionTableVerificationDriftKindCounts = {
  codeDrift: number;
  testDrift: number;
  planAmbiguity: number;
};

export type DecisionTableVerificationRecordDiagnostics = {
  telemetryStatus: "reported";
  telemetryFilePath: string;
  lineNumber: number;
  timestamp: string;
  workdir: string;
  decisionTablePath: string;
  finalStatus: DecisionTableVerificationFinalStatus;
  iterations: number;
  driftKindCounts: DecisionTableVerificationDriftKindCounts;
  fixesAttempted: number;
  parseFailures: number;
  verifierInvocations: number;
  phaseDurationMs: number;
};

export type DecisionTableVerificationMissingDiagnostics = {
  telemetryStatus: "missing";
  telemetryFilePath: string;
  filePresent: boolean;
  linesRead: number;
  invalidLines: number;
  missingReason: DecisionTableVerificationMissingReason;
  sinceIso?: string;
  readError?: string;
};

/**
 * Decision-table verifier telemetry extracted from the JSONL file emitted by
 * Phase 5.5 after an EXECUTE loop exits.
 */
export type DecisionTableVerificationTelemetryDiagnostics =
  | DecisionTableVerificationRecordDiagnostics
  | DecisionTableVerificationMissingDiagnostics;

/**
 * Discriminated union covering all perf.jsonl event types produced by the Loop
 * orchestrator. The `event` field acts as the discriminator key.
 *
 * All field names are camelCase (converted from the snake_case used in the raw
 * JSONL file). Fields introduced in newer producer versions (e.g. `command`,
 * token counters) are typed as optional/nullable so legacy records without those
 * fields parse cleanly with the missing values rendered as `null`.
 */
export type LoopPerfEventDiagnostics =
  | LoopPerfRunEvent
  | LoopPerfPhaseEvent
  | LoopPerfIterationEvent
  | LoopPerfPipelineStepEvent
  | LoopPerfAgentEvent
  | LoopPerfToolEvent
  | LoopPerfSkillEvent
  | LoopPerfSpawnEvent
  | LoopPerfParseFailureEvent;

/**
 * Optional fields on these LoopPerf* events use `?: T` (omit when absent)
 * rather than `?: T | null` so the diagnostics payload preserves
 * source-record omission. symphony-alpha consumes this contract and may add
 * these fields with optional-but-non-nullable schemas; emitting an explicit
 * `null` for a field the producer didn't write would cause those schemas to
 * reject otherwise-valid events. The orphan-sentinel emit path for a
 * `tool` event sets `endedAt`, `durationS`, and `ok` to null deliberately —
 * those are typed as `T | null` because null is the intended sentinel for
 * "tool started but never completed".
 */

/** A top-level run record — emitted once per Loop invocation. */
export type LoopPerfRunEvent = {
  event: "run";
  runId: string;
  /** Newer producer versions only; omitted for legacy records. */
  command?: string;
  startedAt: string;
  repo?: string;
  branch?: string;
  /** Harness discriminator (D-007); omitted for legacy plugin records. */
  harness?: LoopHarness;
};

/**
 * A phase transition record — emitted each time the orchestrator enters a new
 * phase (e.g. "Phase 1: Planning"). The `phase` field is the primary Datadog
 * facet documented by FEA-890.
 */
export type LoopPerfPhaseEvent = {
  event: "phase";
  runId: string;
  iteration: number;
  phase: string;
  status: string;
  startSha?: string;
  startedAt: string;
  /** Newer producer versions only; omitted for legacy records. */
  command?: string;
  /** Harness discriminator (D-007); omitted for legacy plugin records. */
  harness?: LoopHarness;
};

/** An iteration summary record — emitted once per Loop iteration on completion. */
export type LoopPerfIterationEvent = {
  event: "iteration";
  runId: string;
  iteration: number;
  /** Newer producer versions only; omitted for legacy records. */
  command?: string;
  startedAt: string;
  endedAt: string;
  durationS: number;
  claudeExitCode?: number;
  status: string;
  /** Harness discriminator (D-007); omitted for legacy plugin records. */
  harness?: LoopHarness;
};

/** A pipeline-step record — emitted for each step in the post-iteration pipeline. */
export type LoopPerfPipelineStepEvent = {
  event: "pipeline_step";
  runId: string;
  iteration: number;
  /** Newer producer versions only; omitted for legacy records. */
  command?: string;
  step: number;
  stepName: string;
  startedAt: string;
  endedAt: string;
  durationS: number;
  exitCode?: number;
  skipped: boolean;
  /** Harness discriminator (D-007); omitted for legacy plugin records. */
  harness?: LoopHarness;
};

/** An agent record — emitted once per agent invocation. */
export type LoopPerfAgentEvent = {
  event: "agent";
  runId: string;
  iteration: number;
  agentId: string;
  agentType: string;
  agentName: string;
  startedAt: string;
  endedAt: string;
  durationS: number;
  /** Newer producer versions only; omitted for legacy records. */
  command?: string;
  model?: string;
  parentSessionId?: string;
  /** Token counters from FEA-888; omitted for legacy records. */
  inputTokens?: number;
  outputTokens?: number;
  cacheCreationInputTokens?: number;
  cacheReadInputTokens?: number;
  totalContextTokens?: number;
  /** Phase attributed via running-phase state; omitted if no prior phase seen. */
  phase?: string;
  /** Harness discriminator (D-007); omitted for legacy plugin records. */
  harness?: LoopHarness;
};

/** A tool-call record — emitted for each tool invocation within an agent. */
export type LoopPerfToolEvent = {
  event: "tool";
  runId: string;
  /** Newer producer versions only; omitted for legacy records. */
  command?: string;
  iteration: number;
  agentId: string;
  toolName: string;
  startedAt: string;
  /**
   * `null` is the intentional sentinel for "tool started but never completed"
   * (orphan-sentinel reconciliation). For completed tool records these carry
   * concrete values; legacy records that omit them entirely are surfaced as
   * absent rather than null.
   */
  endedAt?: string | null;
  durationS?: number | null;
  ok?: boolean | null;
  /** Phase attributed via running-phase state; omitted if no prior phase seen. */
  phase?: string;
  /** Harness discriminator (D-007); omitted for legacy plugin records. */
  harness?: LoopHarness;
};

/** A skill record — emitted for each skill invocation. */
export type LoopPerfSkillEvent = {
  event: "skill";
  runId: string;
  /** Newer producer versions only; omitted for legacy records. */
  command?: string;
  iteration: number;
  agentId: string;
  toolName: string;
  skillName: string;
  startedAt: string;
  endedAt: string;
  durationS: number;
  ok: boolean;
  /** Phase attributed via running-phase state; omitted if no prior phase seen. */
  phase?: string;
  /** Harness discriminator (D-007); omitted for legacy plugin records. */
  harness?: LoopHarness;
};

/** A subagent-spawn record — emitted when the orchestrator spawns a subagent. */
export type LoopPerfSpawnEvent = {
  event: "spawn";
  runId: string;
  /** Newer producer versions only; omitted for legacy records. */
  command?: string;
  iteration: number;
  parentSessionId?: string;
  parentAgentId: string;
  plannedSubagentType?: string;
  startedAt: string;
  /** Phase attributed via running-phase state; omitted if no prior phase seen. */
  phase?: string;
  /** Harness discriminator (D-007); omitted for legacy plugin records. */
  harness?: LoopHarness;
};

/**
 * A synthetic parse-failure record — NOT emitted by the Loop orchestrator.
 * The desktop scanner emits this for lines that fail JSON parsing or Zod
 * validation, carrying enough context to diagnose the bad line.
 */
export type LoopPerfParseFailureEvent = {
  event: "parse_failure";
  lineNumber: number;
  rawBytes: string;
  errorMessage: string;
};

export type OutboundNetworkSurface =
  | "loop_attachment_download"
  | "loop_support_upload"
  | "deploy_health_check";

export type OutboundNetworkDecision = "allowed" | "denied";

export type OutboundNetworkDestinationClass =
  | "external"
  | "invalid"
  | "ip_literal"
  | "link_local"
  | "loopback"
  | "metadata"
  | "private"
  | "s3_path_style"
  | "s3_virtual_hosted";

export type OutboundNetworkDecisionReason =
  | "allowed"
  | "attachment_host_not_allowed"
  | "credentialed_url"
  | "deploy_host_not_allowed"
  | "invalid_url"
  | "ip_literal_not_allowed"
  | "link_local_address_not_allowed"
  | "metadata_address_not_allowed"
  | "path_style_s3_not_allowed"
  | "private_address_not_allowed"
  | "unsupported_protocol";

export type OutboundNetworkDiagnostics = {
  surface: OutboundNetworkSurface;
  decision: OutboundNetworkDecision;
  reason: OutboundNetworkDecisionReason;
  destinationClass: OutboundNetworkDestinationClass;
  protocol?: string;
  hostname?: string;
  port?: string;
  statusCode?: number;
};

export type SupportUploadOutcome =
  | "started"
  | "skipped"
  | "succeeded"
  | "failed";
export type SupportUploadReason =
  | "already_uploaded"
  | "missing_s3_state_key"
  | "missing_token"
  | "no_uploadable_files"
  | "upload_url_http_error"
  | "upload_url_malformed_response"
  | "upload_url_success_false"
  | "upload_url_missing_url"
  | "upload_url_request_failed"
  | "put_url_denied"
  | "put_http_error"
  | "put_request_failed"
  | "event_post_failed";

export type SupportUploadDiagnostics = {
  outcome: SupportUploadOutcome;
  loopId?: string;
  s3StateKeySuffix?: string;
  attemptedLogicalNames?: string[];
  attemptedUploadedNames?: string[];
  reason?: SupportUploadReason;
  uploadedCount?: number;
  durationMs?: number;
};

export type DesktopUpdateTelemetryTrigger =
  | "updater-error"
  | "check-for-updates"
  | "manual-check"
  | "apply-before-downloaded"
  | "renderer-apply-update"
  | "gateway-apply-update"
  | "install-blocked-read-only-volume";

export type DesktopUpdateDiagnostics = {
  trigger: DesktopUpdateTelemetryTrigger;
  status?: string;
  version?: string;
  percent?: number;
  error?: string;
  downloaded?: boolean;
  readyToInstall?: boolean;
};

export type DesktopShutdownTelemetryTrigger =
  | "before-quit"
  | "shutdown-sequence"
  | "shutdown-rejected"
  | "outer-hard-exit"
  | "update-install-failed";

export type DesktopShutdownDiagnostics = {
  trigger: DesktopShutdownTelemetryTrigger;
  result?: "timed_out" | "failed";
  phase?: string;
  duringUpdate?: boolean;
  outerHardExit?: boolean;
  elapsedMs?: number;
  error?: string;
};

export type PluginUpdateOutcome = "success" | "failed" | "timeout" | "skipped";

export type PluginUpdateFailureReason =
  | "command_failed"
  | "timeout"
  | "still_outdated"
  | "cli_unavailable"
  | "manifest_unavailable"
  | "unknown";

export type PluginUpdateDiagnostics = {
  pluginIds: string[];
  versionsBefore: Record<string, string>;
  versionsAfter: Record<string, string>;
  outcomes: Record<string, PluginUpdateOutcome>;
  durationMs: number;
  command: "claude plugin update";
  scope: "user";
  exitCode?: number;
  failureReason?: PluginUpdateFailureReason;
  stderrTail?: string;
};

/**
 * FEA-1999 — desktop SQLite store integrity probe.
 *
 * Which check produced an issue. `quick_check` is `PRAGMA quick_check(N)` (the
 * cheap variant, run off the hot path on a reader connection); `index_presence`
 * is the manifest-vs-`sqlite_master` guard that an expected index is still
 * present (the FEA-1968-class regression).
 */
export type StoreIntegrityCheckName =
  | "quick_check"
  | "index_presence"
  | "token_parity";

/**
 * A bounded classification of a `PRAGMA quick_check` / index-presence problem.
 * The raw SQLite error string is NEVER forwarded — it is mapped to one of these
 * categories so the wire payload can never carry row content.
 */
export type StoreIntegrityIssueCategory =
  | "missing_index_entry"
  | "wrong_index_entry_count"
  | "non_unique_index_entry"
  | "malformed_structure"
  | "constraint"
  | "missing_index"
  | "token_store_divergence"
  | "other";

/** The kind of database object an issue names (a schema identifier only). */
export type StoreIntegrityObjectType = "index" | "table" | "unknown";

/**
 * One redacted integrity issue. `object` is a single `[A-Za-z0-9_]` schema
 * identifier (an index or table name) extracted from the check output; rowids,
 * page numbers, and column values are dropped before this is built, so it can
 * never carry row content.
 */
export type StoreIntegrityIssue = {
  check: StoreIntegrityCheckName;
  category: StoreIntegrityIssueCategory;
  object?: string;
  objectType?: StoreIntegrityObjectType;
};

/**
 * The result of one integrity probe run. Carries only bounded, content-free
 * fields: the health verdict, the probe duration, which checks ran, the issue
 * count, a capped list of redacted issues, and whether that list was truncated.
 */
export type StoreIntegrityDiagnostics = {
  healthy: boolean;
  durationMs: number;
  checksRun: StoreIntegrityCheckName[];
  issueCount: number;
  issues: StoreIntegrityIssue[];
  truncated: boolean;
};

export type TelemetryDiagnostics = {
  exitCode?: number;
  logTail?: string;
  stderrTail?: string;
  exitSignal?: string;
  elapsedMs?: number;
  stdoutBytes?: number;
  abortReason?: string;
  planSource?: ExecutePlanSourceDiagnostics;
  spawnMeta?: {
    command: string;
    args: string[];
    cwd: string;
    claudeVersion?: string;
    binaryPath: string;
    authFilesExist: boolean;
    envSnapshot: Record<string, string>;
  };
  tokenUsage?: { inputTokens: number; outputTokens: number };
  decisionTableVerification?: DecisionTableVerificationTelemetryDiagnostics;
  desktopUpdate?: DesktopUpdateDiagnostics;
  desktopShutdown?: DesktopShutdownDiagnostics;
  pluginUpdate?: PluginUpdateDiagnostics;
  outboundNetwork?: OutboundNetworkDiagnostics;
  supportUpload?: SupportUploadDiagnostics;
  diagnosticsVersion?: number;
  errorStack?: string;
  extra?: Record<string, unknown>;
  tokenCostPricingMiss?: TokenCostPricingMissDiagnostics;
  storeIntegrity?: StoreIntegrityDiagnostics;
  loopPerf?: LoopPerfEventDiagnostics;
  lifecycle?: {
    command?: LoopCommand;
  };
};

/** Telemetry event payload without protocol envelope fields (added by transport layer). */
export type TelemetryEventPayload = {
  severity: TelemetrySeverity;
  category: TelemetryCategory;
  message: string;
  schemaVersion?: string;
  timestamp?: string;
  trace?: TelemetryTraceContext;
  diagnostics?: TelemetryDiagnostics;
};

export type TelemetryEmitter = {
  emit(event: TelemetryEventPayload): void;
};

/** Full wire-format event including protocol envelope (used by transport layer). */
export interface DesktopTelemetryEvent extends ProtocolEnvelope {
  severity: TelemetrySeverity;
  category: TelemetryCategory;
  message: string;
  schemaVersion: string;
  timestamp: string;
  trace?: TelemetryTraceContext;
  diagnostics?: TelemetryDiagnostics;
}
