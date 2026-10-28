import type { JsonObject } from "./common";

export type ComputeTargetServerCapabilities = {
  computeTargetSigning?: boolean;
  agentSessionSync?: boolean;
  /**
   * FEA-4138: the server can accept a gzip-compressed agent-session sync body
   * (`Content-Encoding: gzip`) and decompress it under a bounded ceiling. Only
   * an explicit `true` opts the desktop into compressing; a missing/false value
   * (older server, or a server that hasn't rolled the decompressor) keeps the
   * desktop on the legacy uncompressed + chunker path. Additive and negotiated
   * exactly like `agentSessionSync` / `computeTargetSigning`.
   */
  agentSessionSyncCompression?: boolean;
  /**
   * ISS-4541: the server can accept an oversized session's activity-segment
   * tiling PAGINATED across multiple chunk payloads (each chunk carrying a
   * disjoint slice of `activitySegmentRows`) and MERGE the slices additively
   * into the full stored tiling, rather than requiring the whole tiling
   * replicated into every chunk. Only an explicit `true` opts the desktop into
   * paginating the tiling across chunks; a missing/false value (an older server
   * that still REPLACE-ALLs the tiling on every chunk) keeps the desktop
   * replicating the full tiling into the base payload — which either fits or
   * dead-letters the whole session for a larger-payload retry, and is never
   * silently truncated. Additive and negotiated exactly like
   * `agentSessionSync` / `agentSessionSyncCompression`.
   */
  agentSessionSyncActivityChunking?: boolean;
  /**
   * ISS-9859: the server merges a session part marked `prRefsPaginated` into the
   * session's stored PR links instead of replacing them. There is NO
   * commit-time sweep — an earlier draft promised one and it was not built,
   * because it is not needed: the FIRST slice part of a sequence rides UNMARKED
   * and therefore takes the ordinary replace path, so retraction happens there
   * and the marked parts that follow are purely additive. Only an explicit `true` lets
   * the desktop paginate `prRefs` across parts. Without it `prRefs` ride every
   * part whole, which fits or dead-letters the session, because an older server
   * would REPLACE the links with each part's slice.
   */
  agentSessionSyncPrRefChunking?: boolean;
  /** Server accepts the additive monitored-session activity ref carrier. */
  agentSessionSyncMonitoredActivity?: boolean;
  /**
   * ISS-5850: the server's `sessionSpanSchema` knows `SessionSpan.startMs` /
   * `endMs` — the absolute extent the producer's activity bins tile — and
   * therefore PERSISTS them rather than stripping them.
   *
   * Unlike the flags above, this one does not select what the desktop SENDS: the
   * pair is additive and optional, so an older server silently drops it with no
   * harm to the rest of the payload. What it selects is what the desktop is
   * allowed to consider DELIVERED. The session lane's durable cursor stamps a
   * payload-contract revision, and a stamped revision means "every row behind
   * this watermark carries that contract" — so stamping the extent-bearing
   * revision after an older server dropped the field would record a replay as
   * done that never happened, leaving those sessions bounds-less forever with
   * nothing left to re-push them (`AGENT_SESSION_SYNC_INTEGRITY_VERSION`).
   * Gating the stamp on this flag is what keeps that replay owed until a server
   * that can actually store the extent acknowledges it.
   *
   * Missing/false (an older server) is therefore not a degraded mode — it is the
   * desktop declining to claim delivery it cannot prove.
   */
  agentSessionSyncSpanExtent?: boolean;
  /**
   * ISS-7896: the server preserves `metadata.humanTurnTimestamps` WHOLE — up to
   * this key's own 1000-entry bound — rather than capping it at the generic
   * `MAX_METADATA_ARRAY_ITEMS` (100) its persist boundary applies to an
   * unrecognized array.
   *
   * Same shape of guarantee as `agentSessionSyncSpanExtent` above, and gated for
   * the same reason: it does not select what the desktop SENDS (the key is
   * additive, and an older server stores a capped copy rather than rejecting the
   * batch), it selects what the desktop may consider DELIVERED. An older server
   * answers a normal ack for a 250-entry array it truncated to 100, and the
   * cloud heatmap then reads that array as AUTHORITATIVE — reporting 100 human
   * turns for a session that had 250, permanently, because the keyset cursor
   * walks `sessions.updated_at` and nothing re-pushes an unchanged session
   * (`AGENT_SESSION_SYNC_INTEGRITY_VERSION`).
   *
   * Gating the stamp on this flag is what keeps the one-time replay owed until a
   * server that actually stores the whole array acknowledges it — so a release
   * that ships Desktop before the API self-corrects on the first connection to a
   * capable API instead of silently under-reporting forever.
   */
  agentSessionSyncHumanTurnTimestamps?: boolean;
  /**
   * ISS-9864: the server's persist boundary preserves `metadata.agentTurnTimestamps`
   * whole rather than capping it at the generic 100-item array bound, and its
   * activity heatmap reads that key as authoritative on a session that synced no
   * token events. Gates the desktop's cursor stamp exactly as
   * `agentSessionSyncHumanTurnTimestamps` does, for the same reason: an older
   * server stores a capped copy, acks normally, and the heatmap would then read
   * 100 agent turns as measured, permanently.
   */
  agentSessionSyncAgentTurnTimestamps?: boolean;
  /**
   * ISS-12552: the server accepts a token event's `agentExternalId` (the owning
   * subagent, or `$parent`) and corrects a stored owner from it. An older
   * server treats any owner differing from the stored one as a transport
   * identity collision and rejects the batch, and every event it already holds
   * was stored without one, so the desktop sends owners only under this flag.
   */
  agentSessionSyncTokenEventOwner?: boolean;
};

export const DesktopSecurityStatus = {
  Protected: "protected",
  UpgradeAvailable: "upgrade_available",
  UpdateRequired: "update_required",
  LegacyManual: "legacy_manual",
  Unknown: "unknown",
} as const;
export type DesktopSecurityStatus =
  (typeof DesktopSecurityStatus)[keyof typeof DesktopSecurityStatus];

export type DesktopSecurityReason =
  | "BOUND_DESKTOP_MANAGED_KEY"
  | "NO_BOUND_MANAGED_KEY"
  | "MISSING_GATEWAY_ID"
  | "UNSUPPORTED_DESKTOP_VERSION"
  | "TARGET_OFFLINE"
  | "SHARED_TARGET"
  | "FEATURE_DISABLED"
  | "LOOKUP_FAILED";

export type ComputeTargetSecurity = {
  status: DesktopSecurityStatus;
  reason: DesktopSecurityReason;
  upgradeSupported: boolean;
};

export type ComputeTarget = {
  id: string;
  organizationId: string;
  userId: string;
  machineName: string;
  platform: string;
  gatewayId?: string;
  capabilities: JsonObject;
  supportedOperations: string[];
  lastSeenAt: Date;
  isOnline: boolean;
  /**
   * @deprecated ISS-12617 retired target sharing. The API still sends `false`
   * so a client built before the change keeps parsing; ISS-12450 removes the
   * field once no such client can be served.
   */
  isSharedWithOrg?: boolean;
  serverCapabilities?: ComputeTargetServerCapabilities;
  security?: ComputeTargetSecurity;
  ownerName?: string;
  createdAt: Date;
  updatedAt: Date;
};

export type CheckResultDebug = {
  errorCode?: string;
  stderr?: string;
  resolvedPath?: string;
  shell?: string;
  platform?: string;
  foundAt?: string[];
  overrideUsed?: string;
};

export const PluginUpdateOutcome = {
  Success: "success",
  Failed: "failed",
  Timeout: "timeout",
  Skipped: "skipped",
} as const;
export type PluginUpdateOutcome =
  (typeof PluginUpdateOutcome)[keyof typeof PluginUpdateOutcome];

export type RemediationLink = {
  label: string;
  url: string;
};

export type CheckResult = {
  id: string;
  label: string;
  required: boolean;
  passed: boolean;
  version?: string;
  error?: string;
  remediation?: string;
  debug?: CheckResultDebug;
  enableAttempted?: boolean;
  enableOutcome?: PluginUpdateOutcome;
  enablePluginIds?: string[];
  updateAttempted?: boolean;
  updateOutcome?: PluginUpdateOutcome;
  updatePluginIds?: string[];
  remediationLinks?: RemediationLink[];
  /**
   * How the panel should read this row. Additive and optional: a gateway that
   * predates ISS-5369 omits it.
   */
  severity?: CheckSeverity;
  /**
   * Id of the check that must be fixed before this one can be determined at
   * all. Set alongside `severity: "blocked"`, so the panel can point at the
   * single actionable fault instead of repeating a remediation that cannot
   * succeed while the blocker stands.
   */
  blockedBy?: string;
  /**
   * Whether — and how — this failing row can be repaired from the web without
   * the user copy-pasting into a terminal. Absent on older Desktop builds, which
   * consumers must read as "this gateway cannot repair anything" rather than as
   * "everything is repairable" (ISS-5389).
   */
  repair?: CheckResultRepair;
};

/**
 * Severity tiers for a System Check row (ISS-5369).
 *
 * The panel previously had two states — passed, or a red failure — so any
 * finding it could not prove had to be rendered as a failure. `Blocked` and
 * `Unknown` exist so an undeterminable check stops asserting a fault it has no
 * evidence for, and `Warning` so a non-blocking finding stops reading as one.
 */
export const CheckSeverity = {
  Passed: "passed",
  /** Non-blocking finding. The command can still run. */
  Warning: "warning",
  /** Not determinable until `blockedBy` is fixed. Asserts nothing about this check. */
  Blocked: "blocked",
  /** Could not be determined, with no single blocking check to name. */
  Unknown: "unknown",
  /** A real, proven failure. */
  Error: "error",
} as const;
export type CheckSeverity = (typeof CheckSeverity)[keyof typeof CheckSeverity];

/**
 * Wire identities of the two AI-harness CLI rows (ISS-5687).
 *
 * The gateway produces the row and cloud consumers read it back by id. They live here rather than in
 * `apps/desktop` because harness availability is derived cloud-side
 * (`deriveAvailableHarnesses`), and `packages/api`/`apps/app` cannot import a
 * desktop module — which is how availability came to be derived from the
 * optional MCP entry instead of from the CLI that actually runs the harness.
 */
export const CLAUDE_CLI_CHECK_ID = "claude-cli";
export const CODEX_CLI_CHECK_ID = "codex";

/**
 * What the gateway would actually DO for a repairable check row. Every value
 * here maps to a concrete step the Desktop gateway can run on its own machine;
 * a failure with no entry here is not repairable and must say so instead of
 * offering a control that does nothing (ISS-5389).
 */
export const HealthCheckRepairAction = {
  /** Clear a binary-path override whose target no longer exists / is not executable. */
  ClearBinaryOverride: "clear_binary_override",
  /** Run `claude plugin enable <id> --scope user` for the disabled Closedloop plugins. */
  EnablePlugins: "enable_plugins",
  /**
   * Register the Closedloop MCP server with a provider that has none, via
   * `claude mcp add --transport http --scope user` / `codex mcp add --url`
   * (ISS-5435). Both providers use this one action; the step names which.
   */
  ConfigureMcp: "configure_mcp",
} as const;
export type HealthCheckRepairAction =
  (typeof HealthCheckRepairAction)[keyof typeof HealthCheckRepairAction];

/** Per-row repairability, attached by the gateway to each check it returns. */
export type CheckResultRepair = {
  repairable: boolean;
  /** Set when `repairable` is true. */
  action?: HealthCheckRepairAction;
  /**
   * Why this row cannot be repaired from here, in the user's words. Required
   * reading when `repairable` is false — a red row with no explanation is the
   * dead affordance this contract exists to prevent.
   */
  reason?: string;
  /**
   * The check whose failure has to be repaired first. When set, this row is a
   * cascade of that root fault and must not be actioned on its own.
   */
  blockedByCheckId?: string;
};
