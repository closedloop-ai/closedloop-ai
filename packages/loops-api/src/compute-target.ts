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
  /** Server accepts the additive monitored-session activity ref carrier. */
  agentSessionSyncMonitoredActivity?: boolean;
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
  isSharedWithOrg: boolean;
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
   * predates ISS-5369 omits it, and consumers fall back to the legacy
   * `passed`/`error` derivation (see `resolveCheckSeverity`). A value this
   * client does not recognise (newer gateway) also falls back rather than
   * rendering an unknown state.
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

export type BackendMismatchBody = {
  error: "backend_mismatch";
  message: string;
  originalComputeTargetId: string | null;
  originalComputeTargetName: string | null;
  preferredComputeTargetId: string | null;
  documentId: string;
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

const KNOWN_CHECK_SEVERITIES = new Set<string>(Object.values(CheckSeverity));

/**
 * Resolve the severity a consumer should render for a check row.
 *
 * Version-skew tolerant in both directions: an older gateway sends no
 * `severity` and gets the legacy derivation (a passing row carrying an `error`
 * has always been the panel's advisory tier); a newer gateway sending a
 * severity this build does not know falls back to that same derivation instead
 * of rendering an unrecognised state.
 */
export function resolveCheckSeverity(
  check: Pick<CheckResult, "passed" | "error" | "severity">
): CheckSeverity {
  if (check.severity && KNOWN_CHECK_SEVERITIES.has(check.severity)) {
    return check.severity;
  }
  if (!check.passed) {
    return CheckSeverity.Error;
  }
  return check.error ? CheckSeverity.Warning : CheckSeverity.Passed;
}

/** True when a row reports a finding the user cannot be expected to act on directly. */
export function isIndeterminateCheckSeverity(severity: CheckSeverity): boolean {
  return (
    severity === CheckSeverity.Blocked || severity === CheckSeverity.Unknown
  );
}

/**
 * The Gateway Version row's wire identity (ISS-5369).
 *
 * The gateway produces the row and the web panel relabels/normalizes it, so
 * the id and the user-facing label are a shared contract in the same category
 * as `CheckSeverity` and `blockedBy` above. Declared once here so a rename on
 * one side cannot silently disagree with the other.
 */
export const APP_VERSION_CHECK_ID = "app-version";
export const APP_VERSION_CHECK_LABEL = "Gateway Version";

/**
 * Wire identities of the two AI-harness CLI rows (ISS-5687).
 *
 * Same category as `APP_VERSION_CHECK_ID`: the gateway produces the row and
 * cloud consumers read it back by id. They live here rather than in
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

/** Terminal state of one repair step. */
export const HealthCheckRepairStepStatus = {
  Succeeded: "succeeded",
  Failed: "failed",
  /** Deliberately not run — normally because a root fault blocked it. */
  Skipped: "skipped",
} as const;
export type HealthCheckRepairStepStatus =
  (typeof HealthCheckRepairStepStatus)[keyof typeof HealthCheckRepairStepStatus];

/**
 * One step the gateway ran (or deliberately did not run) during a repair. The
 * step names itself and carries its own reason so a failure is never a generic
 * red — see `detail`.
 */
export type HealthCheckRepairStep = {
  action: HealthCheckRepairAction;
  /** Human-readable name of the step, e.g. "Clear stale Claude CLI path override". */
  label: string;
  status: HealthCheckRepairStepStatus;
  /** Check ids this step was meant to fix. */
  checkIds: string[];
  /** Why it failed, or why it was skipped. Always present unless it succeeded. */
  detail?: string;
};

/**
 * The one predicate that decides whether a System Check row BLOCKS a command.
 *
 * Every consumer that answers "is this machine ready?" calls this — the cloud
 * pre-loop gate and summary badge (`apps/app/lib/system-check`) and the gateway
 * that mints `allRequiredPassed` (`apps/desktop`, ISS-5868). It lives here
 * because it is the only module both surfaces can import, and because two
 * hand-written copies of `required && !passed` are exactly how the two sides
 * came to disagree.
 *
 * `required && !passed` alone was not enough (ISS-5811). ISS-5369 introduced
 * `severity: "unknown" | "blocked"` precisely so a row the gateway COULD NOT
 * DETERMINE stops asserting a fault it has no evidence for — the producer even
 * says so where it mints the row: "That is not-determinable, not a proven
 * failure". But those rows still carry `passed: false`, and the cloud predicate
 * read only `passed`, so an undeterminable row blocked every Generate/Execute
 * launch exactly as hard as a proven one. On the reported machine the five
 * Closedloop plugin rows were all "Could not verify enabled state" with
 * `repair.repairable: false` — five blockers the user had no action for, which
 * made web→desktop commands unlaunchable with no request ever reaching the API.
 *
 * `Warning` is exempt for the same reason and on the contract's own words —
 * "Non-blocking finding. The command can still run." A REQUIRED row the gateway
 * deliberately downgraded to `warning` was still blocking purely because it also
 * carried `passed: false`, which is the identical `passed`-only read.
 *
 * A PROVEN failure still blocks: `PLUGIN_DISABLED_ERROR` ("Disabled") and a
 * missing binary carry no indeterminate severity and are unchanged here.
 * Version skew is safe in both directions because `resolveCheckSeverity` owns
 * it: a gateway predating ISS-5369 sends no `severity` and a newer one may send
 * a value this build does not know, and both fall back to the legacy
 * `!passed → error` derivation — i.e. they keep blocking rather than being
 * guessed non-blocking off a signal that was never sent. A row claiming
 * `severity: "passed"` while reporting `passed: false` is self-contradictory
 * rather than downgraded, so it is NOT exempted: it keeps blocking.
 */
export function isFailingRequiredCheck(
  check: Pick<CheckResult, "required" | "passed" | "error" | "severity">
): boolean {
  if (!(check.required && !check.passed)) {
    return false;
  }
  const severity = resolveCheckSeverity(check);
  return !(
    isIndeterminateCheckSeverity(severity) || severity === CheckSeverity.Warning
  );
}
