import type { SyncLane } from "@closedloop-ai/telemetry-contract/sync";
import type {
  INVOCATION_SYNC_MISSING_PARENTS_CATEGORY,
  InvocationSyncMissingParents,
} from "@repo/api/src/types/invocation-sync-diagnostics";
import type { StreamRunErrorCode } from "../../shared/install-run-contract.js";
import type {
  SyncLaneDeadLetteredBasis,
  SyncLaneStallKind,
} from "../../shared/sync-burndown-contract.js";
import type { TokenCostNotPricedReason } from "../../shared/token-cost.js";
import type { ProtocolEnvelope } from "../cloud/cloud-protocol.js";
import type { LocalReadFailedDiagnostics } from "./local-read-failed-diagnostics.js";
import type {
  SyncLaneGiveUpDiagnostics,
  SyncLaneReArmDiagnostics,
} from "./sync-lane-give-up-diagnostics.js";

export const TELEMETRY_MAX_FIELD_BYTES = 4096; // 4 KiB

export type TelemetrySeverity = "info" | "warn" | "error";

/**
 * ISS-8331 — a DB-host-only relay discriminator. Main consumes this event and
 * emits the monitored `app.exception` span on the child's behalf; it never
 * reaches the generic telemetry transport as a second, duplicate record.
 */
export const MARKETPLACE_MANIFEST_INVALID_TELEMETRY_CATEGORY =
  "catalog.marketplace_manifest_invalid" as const;
export const MARKETPLACE_MANIFEST_VALIDATION_ERROR_NAME =
  "MarketplaceManifestValidationError" as const;
export const MARKETPLACE_MANIFEST_VALIDATION_ERROR_MESSAGE =
  "Remote marketplace manifest contained invalid plugin metadata" as const;

export type TelemetryCategory =
  | typeof MARKETPLACE_MANIFEST_INVALID_TELEMETRY_CATEGORY
  | "command.timeout"
  | "command.cancelled"
  | "command.gateway_error"
  | "desktop.outbound_network_decision"
  | "desktop.shutdown_failed"
  | "electron_update.initiated"
  | "electron_update.failed"
  | "distribution.install_gave_up"
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
  | "token_cost.pricing_miss"
  // FEA-1999 — desktop SQLite store integrity-health signal. Four cadence
  // states: a failure is reported once on detection, re-reported on a
  // heartbeat while it persists, and a recovery / first-healthy probe emits a
  // clean signal.
  | "store.integrity.failure_detected"
  | "store.integrity.failure_persistent"
  | "store.integrity.recovered"
  | "store.integrity.healthy"
  // Invocation parts rejected because their parent session was not found in the
  // cloud. Mirrored in
  // `@repo/observability/telemetry/telemetry-category` (`SyncInvocationMissingParents`).
  | typeof INVOCATION_SYNC_MISSING_PARENTS_CATEGORY
  // ISS-5387 — a sync lane completed work while its durable cursor stood still.
  // Mirrored in `@repo/observability/telemetry/telemetry-category` (`SyncDurableCursorStalled`).
  | "sync.durable_cursor.stalled"
  // ISS-7496 — a CONFIRMED sync batch could not be measured for freshness
  // because its own session timestamps were impossible. Mirrored in
  // `@repo/observability/telemetry/telemetry-category` (`SyncFreshestSessionLagUnmeasurable`).
  | "sync.freshest_session_lag.unmeasurable"
  // ISS-7730 — a pending agent-session outbox row carried a `lane_stalled_since`
  // that cannot be right (unreadable, or ahead of the clock that read it), so
  // the only bound the lane-wide `ingestion_failed` class has is not being
  // served. Mirrored in `@repo/observability/telemetry/schema`
  // (`SyncLaneStallClockInvalid`).
  | "sync.lane_stall_clock.invalid"
  // ISS-9418 - a sync lane crossed its 24h ENVIRONMENTAL wall clock and STOPPED
  // ATTEMPTING, and the paired event that says it may attempt again. Read as a
  // pair: a `gave_up` with no matching `rearmed` is a lane that is terminal
  // right now. Emitted once per TRANSITION and never once per tick - see
  // `sync-lane-give-up-telemetry.ts`. Mirrored in
  // `@repo/observability/telemetry/telemetry-category` (`SyncLaneGaveUp` /
  // `SyncLaneReArmed`), which also carries the alert-wiring note and the reason
  // this is the only channel a give-up is ever observed on.
  | "sync.lane.gave_up"
  | "sync.lane.rearmed"
  // ISS-8179 — a durable agent-session outbox clear reported a
  // `deletedRowCount` its own boundary schema rejects, so the rows-cleared
  // burn-down count was omitted for reasons that are NOT version skew. Mirrored
  // in `@repo/observability/telemetry/telemetry-category`
  // (`SyncOutboxClearCountInvalid`).
  | "sync.outbox_clear_count.invalid"
  | "desktop.db_host.exited_unexpectedly"
  // ISS-8776 — the restart ladder gave up; the local store is unavailable for
  // the rest of this session and no further fork will be attempted. Mirrored in
  // `@repo/observability/telemetry/telemetry-category` (`DbHostRestartExhausted`),
  // which also carries the alert-wiring note.
  | "desktop.db_host.restart_exhausted"
  // ISS-7201 — main refused a telemetry event relayed by the DB-host child, so
  // whatever the child was reporting is now lost. Mirrored in
  // `@repo/observability/telemetry/telemetry-category` (`DbHostTelemetryRefused`), which
  // also carries the alert-wiring note.
  | "desktop.db_host.telemetry_refused"
  // ISS-8115 — main refused a db-host child's `invoke` reply because it did not
  // match the boundary schema for that op, so the value did not travel and the
  // caller degraded to its "not established" answer. Mirrored in
  // `@repo/observability/telemetry/telemetry-category` (`DbHostReplyRejected`),
  // which also carries the alert-wiring note.
  | "desktop.db_host.reply_rejected"
  // ISS-6417 — a collector permanently dropped records it had already read off a
  // harness transcript. Mirrored in `@repo/observability/telemetry/telemetry-category`
  // (`CollectorRecordsDropped`), which also carries the alert-wiring note.
  | "collector.records_dropped"
  // ISS-7332 — persisted raw harness result envelopes were dropped on load
  // because the row did not validate. That store is the RECOVERY artifact for
  // the authoritative `total_cost_usd`, so a drop is permanent data loss with
  // no other signal: the load succeeds, the store rewrites itself without the
  // rows, and nothing throws. Mirrored in `@repo/observability/telemetry/telemetry-category`
  // (`HarnessResultEnvelopesDropped`), which carries the alert-wiring note.
  | "cost.harness_result_envelopes_dropped"
  // ISS-9723 — the Desktop branch-trace builder served a trace that is a subset
  // of what it built, because the merged-trace contract refused items a local
  // producer had written. Mirrored in
  // `@repo/observability/telemetry/telemetry-category`
  // (`BranchTraceItemsUnreadable`), which carries the alert-wiring note.
  | "branch_trace.items_unreadable"
  // ISS-11351 — a local durable read failed (Sessions aggregates, component
  // lane). Mirrored in `@repo/observability/telemetry/telemetry-category`
  // (`LocalReadFailed`).
  | "desktop.local_read.failed"
  // ISS-6331 — three distinct renderer-health conditions, kept as three
  // categories so a monitor keys on `@category` rather than unpacking a field.
  // Mirrored in `@repo/observability/telemetry/telemetry-category`.
  | "desktop.renderer.unresponsive"
  | "desktop.renderer.load_failed"
  | "desktop.renderer.reload_budget_exhausted"
  // ISS-6339 — desktop SQLite performance. A periodic sample carrying the
  // statement-duration histogram plus the store/WAL size gauges, and one event
  // per migration step applied at boot. Mirrored in
  // `@repo/observability/telemetry/telemetry-category`.
  | "store.perf.sample"
  | "store.migration.step";

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
  | "imported_token_costs"
  | "component_invocation";

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
  gatewaySessionId?: string;
  desktopClientVersion?: string;
  /**
   * ISS-9743 — the commit the running bundle was built from. Injected per
   * process by `TelemetryService`, never by a call site; see
   * `util/desktop-build-commit.ts` for why `desktopClientVersion` alone cannot
   * name a source build.
   */
  desktopBuildCommit?: string;
};

export type OutboundNetworkSurface =
  | "loop_attachment_download"
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

/**
 * ISS-12435: the support-bundle upload this named was emitted only by the loop
 * finalizer, removed with Loops, so no current build produces it. Builds that
 * predate the removal still send `diagnostics.supportUpload`, and the ingest
 * schema keeps accepting it; this union stays as the producer half of that
 * mirror (`no-unmirrored-desktop-telemetry-enum`) so the two cannot drift.
 */
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

export type DesktopUpdateTrigger =
  | "updater-error"
  | "check-for-updates"
  | "manual-check"
  | "apply-before-downloaded"
  | "renderer-apply-update"
  | "install-blocked-read-only-volume";

export type DesktopUpdateDiagnostics = {
  trigger: DesktopUpdateTrigger;
  status?: string;
  version?: string;
  percent?: number;
  error?: string;
  downloaded?: boolean;
  readyToInstall?: boolean;
};

export type DesktopShutdownTrigger =
  | "before-quit"
  | "shutdown-sequence"
  | "shutdown-rejected"
  | "outer-hard-exit"
  | "update-install-failed";

export type DesktopShutdownDiagnostics = {
  trigger: DesktopShutdownTrigger;
  result?: "timed_out" | "failed";
  phase?: string;
  duringUpdate?: boolean;
  outerHardExit?: boolean;
  elapsedMs?: number;
  error?: string;
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
  // ISS-6209: live invocation-lane delivery rows whose persisted `created_at`
  // cannot be read, so the lane cannot evaluate the retry horizon that decides
  // when it may stop retrying them.
  | "invocation_sync_outbox"
  // ISS-6337: writes the store refused because the disk (or the database) is
  // full. Classified at the write boundary, which is the only place the driver
  // error still carries its result code.
  | "storage_exhaustion"
  // ISS-8259: persisted `sessions.metadata` that is not parseable JSON. Every
  // reader of that column degrades on it rather than throwing, so without this
  // the condition is reachable from many paths and reported by none.
  | "session_metadata"
  // ISS-9981: a local trace-comment write repaired a generation token SQLite
  // cannot read. The write still lands; this check is what makes it visible.
  | "trace_comment_generation";

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
  // ISS-12594: no longer emitted. Kept so this enum mirrors the ingest side,
  // which still accepts these values from installed Desktop builds.
  | "malformed_repository_default_authority"
  | "repository_default_authority_write_failure"
  | "cloud_github_overlay_write_failure"
  // ISS-8259: at least one `sessions` row holds a `metadata` blob that is not
  // valid JSON, so every derivation over it silently skips that session.
  // `object` names the TABLE only — never a session id or a blob fragment.
  | "malformed_session_metadata"
  // ISS-6209: a live invocation-delivery row carries a `created_at` the lane
  // cannot parse. `object` names the offending TABLE only — never the row, the
  // session, or the unreadable value itself.
  | "unreadable_invocation_sync_outbox_timestamp"
  // ISS-5855: the lane permanently ABANDONED an invocation-delivery part because
  // its parent session never reached the cloud inside the retry horizon, and this
  // lane has no dead-letter recovery — so that session's invocation data is
  // permanently incomplete upstream. `object` names the TABLE only; the row,
  // session, and generation stay in the main-process abandonment log.
  | "abandoned_invocation_sync_outbox_part"
  // ISS-6337: the store refused at least one write because it is out of space.
  // `object` carries the bounded `StorageExhaustionReason` — never a filesystem
  // path, which would leak the OS account name (the ISS-6229 class).
  | "storage_exhausted"
  // ISS-9981: at least one local write found `trace_comments.updated_at`
  // unreadable and repaired it to now. `object` names the TABLE only.
  | "unreadable_trace_comment_generation"
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
  /**
   * ISS-8776 — how many restart attempts the ladder actually made, on the
   * `restart_exhausted` event only.
   *
   * OMITTED on the ordinary `exited_unexpectedly` event, where the tally is not
   * yet meaningful. It exists because `crashesInWindow` cannot answer "how bad
   * is this" for the terminal case: that field counts crashes inside the 60 s
   * FEA-3072 window, while the ladder it now reports on spans roughly two
   * minutes, so the earliest failures have aged out by the time it gives up —
   * and on a pure spawn-failure run (no child ever reaching `exit`, which is
   * the shape of the incident) it reads 0 against 8 failed attempts. A triage
   * read would take that as "barely tried". This is the honest number, carried
   * beside the windowed one rather than repurposing it.
   */
  restartAttempts?: number;
};

/**
 * ISS-6331 — which renderer-lifecycle listener saw a load failure. SSOT for the
 * enum is the canonical Zod mirror in `@repo/observability/telemetry/renderer-load-failure-source`
 * (`RendererLoadFailureSource`); a value only this side knows about makes the
 * wire schema drop the whole event.
 */
export type RendererLoadFailureSource = "did_fail_load" | "preload_error";

/**
 * ISS-6331 — renderer health, as reported to the monitored path. Counts and
 * closed enums only. `detail` is the sole free-text field and is sanitized by
 * the producer before it is buffered, because the raw value it derives from
 * carries the failing URL — a `file://` install path with the OS account name in
 * it on a packaged app (ISS-6229).
 */
export type RendererHealthDiagnostics = {
  reloadsInWindow: number;
  source?: RendererLoadFailureSource;
  errorCode?: number;
  detail?: string;
};

/**
 * ISS-6170 — which permanent pack-install condition the distribution installer
 * gave up on. `reason` is the PRODUCER's own error code type, so this cannot
 * drift from `streamRun`'s vocabulary; the cloud-side Zod mirror in
 * `packages/observability/telemetry/schema.ts` carries the same closed set.
 */
export type DistributionInstallGaveUpDiagnostics = {
  reason: StreamRunErrorCode;
};

export type TelemetryDiagnostics = {
  exitCode?: number;
  logTail?: string;
  stderrTail?: string;
  exitSignal?: string;
  elapsedMs?: number;
  stdoutBytes?: number;
  abortReason?: string;
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
  desktopUpdate?: DesktopUpdateDiagnostics;
  desktopShutdown?: DesktopShutdownDiagnostics;
  distributionInstallGaveUp?: DistributionInstallGaveUpDiagnostics;
  outboundNetwork?: OutboundNetworkDiagnostics;
  diagnosticsVersion?: number;
  errorStack?: string;
  extra?: Record<string, unknown>;
  tokenCostPricingMiss?: TokenCostPricingMissDiagnostics;
  storeIntegrity?: StoreIntegrityDiagnostics;
  storePerf?: StorePerfDiagnostics;
  migrationStep?: MigrationStepDiagnostics;
  dbHostExit?: DbHostExitDiagnostics;
  dbHostTelemetryRefused?: DbHostTelemetryRefusedDiagnostics;
  dbHostReplyRejected?: DbHostReplyRejectedDiagnostics;
  collectorRecordsDropped?: CollectorRecordsDroppedDiagnostics;
  invocationSyncMissingParents?: InvocationSyncMissingParents;
  syncLaneStall?: SyncLaneStallDiagnostics;
  syncLaneGaveUp?: SyncLaneGiveUpDiagnostics;
  syncLaneReArmed?: SyncLaneReArmDiagnostics;
  harnessResultEnvelopesDropped?: HarnessResultEnvelopesDroppedDiagnostics;
  rendererHealth?: RendererHealthDiagnostics;
  localReadFailed?: LocalReadFailedDiagnostics;
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

/**
 * ISS-6417 — why a collector dropped records it had already read. Bounded and
 * content-free: it names the FAILURE MODE only, never a transcript path, a
 * session, an agent, or the offending value.
 *
 * Declared here beside the other wire-bound bounded enums, and mirrored as
 * `CollectorRecordsDroppedReason` in `@repo/observability/telemetry/collector-records-dropped-reason` with
 * no shared import either way.
 *
 * The receiver COARSENS first (ISS-7488): a value only this side knows about is
 * folded onto that const's own `unknown` member before its `z.enum` runs, so the
 * event, its count and every other diagnostic on the payload arrive, and only
 * this dimension is lost. Desktop and cloud deploy independently, so a producer
 * ahead of the ingest const is the normal state of a fleet mid-rollout — the two
 * halves do NOT have to land together, and this one may ship first.
 *
 * Adding the member on the ingest side is still owed in the same change, because
 * coarsening costs the one dimension the alert groups by.
 * `scripts/lint/rules/no-unmirrored-desktop-telemetry-enum.ts` compares this
 * const against the ingest one and fails CI naming a member declared here that
 * the ingest half lacks: it DETECTS the drift, rather than requiring an atomic
 * deployment to prevent it.
 */
export const CollectorRecordsDroppedReason = {
  /**
   * The record's `timestamp` was a value no `Date` can represent. Read, but not
   * insertable — an event needs a time, and inventing one would be the worse
   * answer.
   */
  UnreadableTimestamp: "unreadable_timestamp",
  /**
   * ISS-5854: the historical-parse worker's response budget dropped whole
   * parsed sessions to fit the process boundary. The source imported a SUBSET
   * of its parse; the dropped sessions have no row anywhere, so this event is
   * the only place their absence is stated.
   */
  SessionResponseBudget: "session_response_budget",
  /**
   * ISS-7534: the historical-parse worker's response budget cut the tail off a
   * session's `tokenSeries`. Parsed, then dropped at the process boundary — so
   * those round-trips reach neither the local store nor the cloud, while the
   * session's `tokensByModel` still reports the full parse's totals.
   */
  TokenSeriesResponseBudget: "token_series_response_budget",
  /**
   * ISS-6999: the sync payload chunker skipped a component-usage unit no single
   * part could carry. Permanent, not deferred — the usage read is deterministic
   * and carries no cursor, so the same unit is skipped again on every pass.
   */
  ComponentUsagePayloadBudget: "component_usage_payload_budget",
  /**
   * ISS-11347: a parsed LLM request whose GenAI span the contract refused (a
   * model id or count out of range). The request is imported as usual; only its
   * span is dropped, so without this every span refused reads the same as an
   * emitter that never shipped.
   */
  GenAiRequestRefused: "gen_ai_request_refused",
} as const;
export type CollectorRecordsDroppedReason =
  (typeof CollectorRecordsDroppedReason)[keyof typeof CollectorRecordsDroppedReason];

/**
 * ISS-6417 — records a collector read and then dropped, as reported to the
 * monitored path. A classification and a count, and deliberately nothing else.
 *
 * `count` must be > 0: the wire schema rejects a zero, because a drop report
 * that says zero describes a drop that did not happen.
 */
export type CollectorRecordsDroppedDiagnostics = {
  reason: CollectorRecordsDroppedReason;
  count: number;
};

/**
 * ISS-7332 — why a persisted raw harness result envelope was dropped on load.
 * Bounded and content-free: it names the FAILURE MODE only, never a loop id, a
 * work dir, or any part of the envelope. The cloud mirror is
 * `HarnessResultEnvelopeDropReason` in `@repo/observability/telemetry/schema`,
 * declared there with no shared import either way — a value only this side knows
 * makes that schema reject the WHOLE event as `telemetry.validation_failed`, so
 * both halves must land together.
 */
export const HarnessResultEnvelopeDropReason = {
  /**
   * The persisted row did not satisfy the retained-envelope schema. Local JSON
   * is a parse boundary: a partial write, a hand edit, or a build that wrote a
   * different shape all land here, and the row cannot be re-parsed into the
   * authoritative cost it existed to preserve.
   */
  CorruptPersistedRow: "corrupt_persisted_row",
} as const;
export type HarnessResultEnvelopeDropReason =
  (typeof HarnessResultEnvelopeDropReason)[keyof typeof HarnessResultEnvelopeDropReason];

/**
 * ISS-7332 — persisted result envelopes dropped on load, as reported to the
 * monitored path. A classification and a count, and deliberately nothing else.
 *
 * `count` must be > 0: the wire schema rejects a zero, because a drop report
 * that says zero describes a drop that did not happen.
 */
export type HarnessResultEnvelopesDroppedDiagnostics = {
  reason: HarnessResultEnvelopeDropReason;
  count: number;
};

/**
 * ISS-7201 — which field made a DB-host child's telemetry event unroutable at
 * main's boundary. Bounded and content-free: it names the FAULT only, never the
 * offending value, the child's category, or any part of the message.
 *
 * Declared here beside the other wire-bound bounded enums (see
 * {@link CollectorRecordsDroppedReason}'s note) and mirrored as
 * `DbHostTelemetryRefusalReason` in `@repo/observability/telemetry/schema` with
 * no shared import either way. A value only this side knows about makes that
 * schema reject the WHOLE event as `telemetry.validation_failed`, so both halves
 * must land together.
 */
export const DbHostTelemetryRefusalReason = {
  /** The relayed `event` was absent, or not an object at all. */
  NotAnObject: "not_an_object",
  /** `severity` was missing, or outside the closed `info`/`warn`/`error` set. */
  InvalidSeverity: "invalid_severity",
  /** `category` was missing, not a string, or empty. */
  MissingCategory: "missing_category",
  /** `message` was missing or not a string. */
  MissingMessage: "missing_message",
  /**
   * The three routing fields were all present and well-formed, but a KNOWN
   * `diagnostics` field carried a value of the wrong type — `logTail` as an
   * object rather than a string, say. Unknown diagnostics keys are NOT this:
   * they ride through untouched, because a newer child is allowed to attach
   * fields this build has never heard of.
   */
  UnknownShape: "unknown_shape",
} as const;
export type DbHostTelemetryRefusalReason =
  (typeof DbHostTelemetryRefusalReason)[keyof typeof DbHostTelemetryRefusalReason];

/**
 * ISS-7201 — a child telemetry event main refused to route, as reported to the
 * monitored path. A single bounded reason, and deliberately nothing else: the
 * refused event's own content is exactly what could not be trusted, so none of
 * it travels.
 */
export type DbHostTelemetryRefusedDiagnostics = {
  reason: DbHostTelemetryRefusalReason;
};

/**
 * ISS-8115 — which db-host reply main refused at the IPC boundary.
 *
 * `db-host-invoke-dispatch` delivers the child's structured-cloned reply
 * VERBATIM, and the main side is a single `as DbHostAgentDatabase` cast on a
 * forwarding Proxy — so the static type of any reply is an ASSERTION about the
 * peer, not a fact about the bytes. This names WHICH contract the peer answered
 * in a shape this build cannot read.
 *
 * Bounded by construction (only ops carrying a boundary schema can reach the
 * reporter) and content-free: an op path is a compile-time constant, never a
 * session id, a row, or any part of the rejected value — which is precisely
 * what could not be trusted.
 *
 * Declared here beside the other wire-bound bounded enums (see
 * {@link DbHostTelemetryRefusalReason}'s note) and mirrored as
 * `DbHostRejectedReplyOp` in `@repo/observability/telemetry/db-host-reply-rejection-reason`
 * with no shared import either way. A value only this side knows about makes
 * that schema reject the WHOLE event as `telemetry.validation_failed`, so both
 * halves must land together.
 */
export const DbHostRejectedReplyOp = {
  /**
   * `syncSource.findExistingSessionIds` — the ONLY sanctioned proof that a
   * queued session is gone (ISS-6031). An unreadable reply must degrade to
   * "absence not established", never to an empty present-set: the latter reads
   * as "all absent" and disposes of the only copy of the data.
   */
  FindExistingSessionIds: "sync_source.find_existing_session_ids",
  /**
   * `syncSource.loadSyncState` — the durable upload cursor. A wrong watermark
   * silently skips rows that were never uploaded; an unreadable one degrades to
   * a full backfill, which costs a re-walk and loses nothing.
   */
  LoadSyncState: "sync_source.load_sync_state",
  /**
   * `syncSource.loadPendingSessionOutboxEngineState` — the persisted retry budget and
   * backoff deadlines rehydrated on resume.
   */
  LoadPendingSessionOutboxEngineState:
    "sync_source.load_pending_outbox_retry_state",
  LoadPendingOutboxRetryState: "sync_source.load_pending_outbox_retry_state",
  /**
   * ISS-8135 — `syncSource.loadPendingOutboxIds`, the once-per-identity resume
   * read that re-selects the enqueued-but-not-acked prefix. An unreadable reply
   * must degrade to "the outbox was not read", never to an empty id list: the
   * latter is a positive claim that nothing is owed, and it COMPLETES the read,
   * so the prefix is never selected again in this process.
   */
  LoadPendingOutboxIds: "sync_source.load_pending_outbox_ids",
  /**
   * ISS-8135 — `syncSource.reEnqueueRecoveredDeadLetter`, the confirmation
   * `enforceDeadLetterCap` gates on before releasing its only in-memory
   * reference to a dead-lettered session. Its consumer tests TRUTHINESS, so any
   * truthy non-boolean read as confirmed and stranded the row.
   */
  ReEnqueueRecoveredDeadLetter: "sync_source.re_enqueue_recovered_dead_letter",
  /**
   * ISS-8135 — `syncSource.findLocallyOversizedSessions`, the only input to the
   * pre-send oversize DROP. A malformed row condemns a session on a size the
   * peer never measured.
   */
  FindLocallyOversizedSessions: "sync_source.find_locally_oversized_sessions",
} as const;

export type DbHostRejectedReplyOp =
  (typeof DbHostRejectedReplyOp)[keyof typeof DbHostRejectedReplyOp];

/**
 * ISS-8115 — a db-host reply main refused, as reported to the monitored path. A
 * single bounded op path, and deliberately nothing else.
 */
export type DbHostReplyRejectedDiagnostics = {
  op: DbHostRejectedReplyOp;
};

/**
 * ISS-6339 — the closed set of statement families a query duration may be
 * labelled with, derived from the leading SQL keyword ONLY.
 *
 * Lives here, beside the other wire-bound bounded enums (see
 * {@link WalProbeAnomalyReason}'s note), rather than in the db-host module that
 * produces it: this is the label that crosses to Datadog, and the ingest schema
 * in `@repo/observability/telemetry/store-integrity` mirrors it. Keying a duration by the
 * SQL text, or by table plus column, would make the label set grow with the
 * store and the workload — the cardinality this enum exists to bound.
 */
export const SqlStatementFamily = {
  Select: "select",
  Insert: "insert",
  Update: "update",
  Delete: "delete",
  /** `PRAGMA` — connection tuning and the WAL/page probes. */
  Pragma: "pragma",
  /** `CREATE` / `ALTER` / `DROP` — schema statements. */
  Ddl: "ddl",
  /** `BEGIN` / `COMMIT` / `ROLLBACK` / `SAVEPOINT` / `RELEASE`. */
  Transaction: "transaction",
  /** Anything else, including a leading keyword this build does not map. */
  Other: "other",
} as const;

export type SqlStatementFamily =
  (typeof SqlStatementFamily)[keyof typeof SqlStatementFamily];

/**
 * ISS-6339 — how one boot migration step finished.
 *
 * `reapplied` is its own outcome rather than a flavour of `applied`: it means
 * the whole-migration attempt rolled back and the runner re-ran the migration
 * statement-by-statement against a store whose schema was already partly there.
 * That is a self-heal on an untracked/partial install, and folding it into
 * `applied` would hide how often installs arrive in that state.
 */
export const MigrationStepOutcome = {
  Applied: "applied",
  Reapplied: "reapplied",
  Failed: "failed",
} as const;

export type MigrationStepOutcome =
  (typeof MigrationStepOutcome)[keyof typeof MigrationStepOutcome];

/** ISS-6339 — one statement family's counts for one sample window. */
export type QueryPerfFamilyDiagnostics = {
  family: SqlStatementFamily;
  count: number;
  slowCount: number;
  maxDurationMs: number;
  /** Histogram counts: one per bucket bound plus a trailing overflow bucket. */
  buckets: number[];
};

/**
 * ISS-6339 — a periodic desktop store performance sample.
 *
 * Counts, durations and byte gauges only. `dbSizeBytes` / `walSizeBytes` are
 * OMITTED when their `stat` did not resolve — never sent as zero, which would
 * read as an empty store rather than an unread one.
 */
export type StorePerfDiagnostics = {
  /** Wall time the sample window covered. */
  windowMs: number;
  slowQueryThresholdMs: number;
  /** Inclusive upper bounds of the histogram buckets, in milliseconds. */
  bucketBoundsMs: number[];
  families: QueryPerfFamilyDiagnostics[];
  dbSizeBytes?: number;
  walSizeBytes?: number;
};

/**
 * ISS-6339 — one boot migration step's duration and outcome.
 *
 * `name` is a migration directory name from THIS BUILD's embedded manifest, so
 * it is bounded by the build rather than by anything the local store contains —
 * unlike the refusal path, where the offending name comes from the store and is
 * deliberately kept off the wire (see `lifecycle/migration-refusal.ts`).
 */
export type MigrationStepDiagnostics = {
  name: string;
  outcome: MigrationStepOutcome;
  durationMs: number;
};

/** ISS-8589: the lane bucket for a vocabulary this build cannot type. */
export const SYNC_LANE_STALL_UNKNOWN = "unknown";

/**
 * ISS-7401 — a sync-lane stall, as structured fields the monitored path can
 * GROUP BY. The canonical mirror is `syncLaneStall` in
 * `@repo/observability/telemetry/schema`, which strips unknown keys, so a field
 * added here that is not added there never reaches the dashboard.
 *
 * Every value is a count, an age, or a closed enum: no session ids, file paths,
 * payload bodies, or credentials, exactly as the alert's message already was.
 *
 * `durableCursorAgeMs` and `itemsRemaining` are OPTIONAL and are OMITTED rather
 * than zeroed when the lane has no such measurement — a stall alert reading
 * `0 items remaining` or `cursor 0s old` states the opposite of the condition it
 * is reporting.
 */
export type SyncLaneStallDiagnostics = {
  /**
   * ISS-8589: {@link SYNC_LANE_STALL_UNKNOWN} when the reporter named a lane
   * this build cannot type, so that drift costs this one field instead of the
   * whole breakdown. The literal mirrors the receiving schema's own bucket for
   * the same case (`@repo/observability/telemetry/schema`, `SYNC_STALL_UNKNOWN`)
   * rather than inventing a second name for it.
   */
  lane: SyncLane | typeof SYNC_LANE_STALL_UNKNOWN;
  kind: SyncLaneStallKind;
  workCompletedSincePrevious: number;
  deadLetteredCount: number;
  /**
   * ISS-9744: WHICH quantity `deadLetteredCount` is — a live queue status count
   * or a durable abandoned-id ledger. OPTIONAL and OMITTED rather than
   * defaulted: a producer that predates this field, or names a basis this build
   * cannot read, leaves the count undimensioned, which is honest. Defaulting it
   * would re-assert the very meaning the field exists to stop guessing.
   */
  deadLetteredBasis?: SyncLaneDeadLetteredBasis;
  durableCursorAgeMs?: number;
  itemsRemaining?: number;
  itemsRemainingIsLowerBound?: boolean;
  queueRowsClearedSincePrevious?: number;
};
