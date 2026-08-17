import type { LoopCommand } from "@closedloop-ai/loops-api/commands";
import type { LoopHarness } from "@closedloop-ai/loops-api/desktop-request";
import type { TokenCostNotPricedReason } from "../../shared/token-cost.js";
import type { ProtocolEnvelope } from "../cloud/cloud-protocol.js";

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
  | "store.integrity.healthy"
  // ISS-5387 — a sync lane completed work while its durable cursor stood still.
  // Mirrored in `@repo/observability/telemetry/schema` (`SyncDurableCursorStalled`).
  | "sync.durable_cursor.stalled"
  | "desktop.db_host.exited_unexpectedly";

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
  | "token_parity"
  // ISS-4818: health of the WAL-depth probe backing the checkpoint cadence's
  // ceiling backstop. A chronically failing probe leaves that backstop disabled,
  // which is a store-health fact, so it rides the same monitored event.
  | "wal_frame_probe"
  // ISS-4976: stored per-invocation telemetry that is impossible (a negative or
  // past-safe-integer count, an out-of-range cost, subagent-only usage on
  // another kind) rather than merely absent. The row→wire projection omits such
  // a value so it cannot dead-letter a generation, which would otherwise make it
  // indistinguishable from "capture never computed it".
  | "invocation_telemetry"
  // ISS-5102: referential integrity — a bounded `PRAGMA foreign_key_check`
  // (dangling FK rows) plus the ISS-5098 FK-less orphan shape (`events.agent_id`
  // with no `agents` row, invisible to `foreign_key_check` because that column
  // deliberately has no FK). Detection only; healing is ISS-5098/ISS-5099.
  | "foreign_key_check"
  // ISS-5838: malformed persisted repository-default authority rows and
  // bounded write-failure signals for the same table.
  | "repository_default_authority";

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
  // ISS-5342: a token TOTAL the parity read cannot legitimately produce (a
  // negative sum, a non-integer, a value past the safe-integer range). Neither
  // token table carries a nonnegative CHECK, so a corrupt store reaches this
  // from the real query — `object` names the offending side and column, never a
  // row value.
  | "token_total_out_of_range"
  // ISS-4818: at least one WAL-depth read against a measurable store yielded no
  // usable frame count, so the ceiling backstop has been running blind.
  | "wal_probe_failure"
  // ISS-4976: a collector wrote an invocation telemetry value the column's own
  // contract forbids. `object` names the offending column (or the table for the
  // kind-mismatch case); no row value ever leaves the machine.
  | "invocation_telemetry_out_of_range"
  // ISS-5102: `PRAGMA foreign_key_check` reported dangling FK rows; `object`
  // names the offending child table only — never a rowid or value.
  | "foreign_key_violation"
  // ISS-5102: rows referencing a parent that no FK constraint guards (the
  // ISS-5098 `events.agent_id` orphan shape). `object` names the child table.
  | "orphaned_row"
  | "malformed_repository_default_authority"
  | "repository_default_authority_write_failure"
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

/**
 * ISS-5715 — an unexpected db-host exit, as reported to the monitored path.
 * Counters only; see the sibling `dbHostExit` schema in
 * `packages/observability/telemetry/schema.ts` for why `exitCode` must not be
 * read as a cause.
 */
export type DbHostExitDiagnostics = {
  exitCode: number | null;
  crashesInWindow: number;
  backoffMs: number;
  rejectedOps: number;
  restartAlreadyInFlight: boolean;
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
  dbHostExit?: DbHostExitDiagnostics;
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

/**
 * ISS-4818 — why a WAL-depth read yielded no usable frame count. Bounded and
 * content-free: it names the FAILURE MODE only, never a path or an error string,
 * so it is safe to carry to fleet telemetry.
 *
 * Lives here, beside the other wire-bound bounded enums, rather than in
 * `database/prisma-client.ts`: it is the value a WAL issue's `object` field
 * carries to Datadog, and `database/database-integrity/store-integrity-probe.ts` must validate
 * incoming reasons against it WITHOUT taking a value import from the Prisma /
 * libSQL runtime that module is deliberately free of.
 */
export const WalProbeAnomalyReason = {
  /**
   * The read completed but produced no usable frame count — a stat failure other
   * than "sidecar absent" (absent is a legitimate depth of 0), or a
   * missing/renamed/negative/non-numeric value.
   */
  MalformedRow: "malformed_row",
  /** The depth read itself threw. */
  ProbeThrew: "probe_threw",
} as const;
export type WalProbeAnomalyReason =
  (typeof WalProbeAnomalyReason)[keyof typeof WalProbeAnomalyReason];
