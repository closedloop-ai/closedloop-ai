import type {
  BackendMismatchBody as SharedBackendMismatchBody,
  CheckResult as SharedCheckResult,
  CheckResultDebug as SharedCheckResultDebug,
  CheckResultRepair as SharedCheckResultRepair,
  ComputeTarget as SharedComputeTarget,
  ComputeTargetSecurity as SharedComputeTargetSecurity,
  ComputeTargetServerCapabilities as SharedComputeTargetServerCapabilities,
  DesktopSecurityReason as SharedDesktopSecurityReason,
  HealthCheckRepairStep as SharedHealthCheckRepairStep,
  RemediationLink as SharedRemediationLink,
} from "@closedloop-ai/loops-api/compute-target";
import {
  CheckSeverity as sharedCheckSeverity,
  CLAUDE_CLI_CHECK_ID as sharedClaudeCliCheckId,
  CODEX_CLI_CHECK_ID as sharedCodexCliCheckId,
  DesktopSecurityStatus as sharedDesktopSecurityStatus,
  HealthCheckRepairAction as sharedHealthCheckRepairAction,
  HealthCheckRepairStepStatus as sharedHealthCheckRepairStepStatus,
  PluginUpdateOutcome as sharedPluginUpdateOutcome,
} from "@closedloop-ai/loops-api/compute-target";
import { z } from "zod";
import type { JsonObject, JsonValue } from "./common";

// Re-export the primitives that are shared verbatim with @closedloop-ai/loops-api
// so existing `@repo/api`/`packages/api` consumers keep their import paths.
export type ComputeTargetServerCapabilities =
  SharedComputeTargetServerCapabilities;
export const DesktopSecurityStatus = sharedDesktopSecurityStatus;
export type DesktopSecurityStatus =
  (typeof DesktopSecurityStatus)[keyof typeof DesktopSecurityStatus];
export type DesktopSecurityReason = SharedDesktopSecurityReason;
export type ComputeTargetSecurity = SharedComputeTargetSecurity;
export type CheckResultDebug = SharedCheckResultDebug;
export const CheckSeverity = sharedCheckSeverity;
export type CheckSeverity = (typeof CheckSeverity)[keyof typeof CheckSeverity];
export const CLAUDE_CLI_CHECK_ID = sharedClaudeCliCheckId;
export const CODEX_CLI_CHECK_ID = sharedCodexCliCheckId;
export const PluginUpdateOutcome = sharedPluginUpdateOutcome;
export type PluginUpdateOutcome =
  (typeof PluginUpdateOutcome)[keyof typeof PluginUpdateOutcome];
export type RemediationLink = SharedRemediationLink;
export type CheckResult = SharedCheckResult;
export type CheckResultRepair = SharedCheckResultRepair;
export const HealthCheckRepairAction = sharedHealthCheckRepairAction;
export type HealthCheckRepairAction =
  (typeof HealthCheckRepairAction)[keyof typeof HealthCheckRepairAction];
export const HealthCheckRepairStepStatus = sharedHealthCheckRepairStepStatus;
export type HealthCheckRepairStepStatus =
  (typeof HealthCheckRepairStepStatus)[keyof typeof HealthCheckRepairStepStatus];
export type HealthCheckRepairStep = SharedHealthCheckRepairStep;
/**
 * `BackendMismatchBody` is the `"backend_mismatch"` variant of the 409
 * compute-target conflict union. The `"multiple_targets"` variant is
 * `ComputeTargetConflictBody` (defined below).
 */
export type BackendMismatchBody = SharedBackendMismatchBody;

/**
 * API-side ComputeTarget: the shared loops-api contract plus the api/app-only
 * `selectedHarness` field. `selectedHarness` is intentionally kept out of the
 * published loops-api contract; it is governed entirely within the web/api
 * boundary via `HarnessType` (defined below).
 */
export type ComputeTarget = SharedComputeTarget & {
  selectedHarness: HarnessType;
};

export type NeutralMcpProviderAvailability = {
  available: boolean;
  serverName: string | null;
  matchedUrl: string | null;
  checkedAt: string;
  error?: string | null;
  /**
   * Repairability for the `<provider>-mcp` row the web synthesizes from this
   * entry (ISS-5435). MCP rows are not gateway `checks[]`, so this is the only
   * place the gateway can state whether Repair can act on one. Absent on a
   * gateway that predates ISS-5435, which reads as "not repairable".
   */
  repair?: CheckResultRepair;
};

export type LegacyMcpProviderAvailability = {
  closedloopAvailable: boolean;
  checkedAt: string;
  /** See `NeutralMcpProviderAvailability.repair`. */
  repair?: CheckResultRepair;
};

export type McpProviderAvailability =
  | NeutralMcpProviderAvailability
  | LegacyMcpProviderAvailability;

export type HealthCheckResponse = {
  checks: CheckResult[];
  allRequiredPassed: boolean;
  // claude/codex are individually optional: the health-check validator accepts a
  // partial mcpServers map (a probe may report only one provider), and consumers
  // already guard each provider before use (deriveAvailableHarnesses, UI hooks).
  mcpServers?: {
    claude?: McpProviderAvailability;
    codex?: McpProviderAvailability;
  };
};

/**
 * Result of a gateway Repair run: the ordered steps the gateway took (or
 * deliberately skipped), plus the health check it re-ran immediately afterwards
 * so the panel updates in place instead of asking the user to re-check by hand
 * (ISS-5389).
 */
export type HealthCheckRepairResponse = {
  steps: HealthCheckRepairStep[];
  result: HealthCheckResponse;
  /**
   * True when this response was served from a repair that was already running —
   * a second press joined the in-flight run instead of starting a second one.
   */
  joinedInFlight?: boolean;
};

export type ComputeTargetHealthCheckSnapshot = {
  id: string;
  organizationId: string;
  computeTargetId: string;
  checkedAt: Date;
  expectedMcpUrl: string | null;
  latestVersion: string | null;
  pluginAutoUpdateEnabled: boolean;
  result: HealthCheckResponse;
  allRequiredPassed: boolean;
  requiredFailureIds: string[];
  schemaVersion: number;
  createdAt: Date;
  updatedAt: Date;
};

export type UpsertComputeTargetHealthCheckSnapshotInput = {
  expectedMcpUrl?: string | null;
  latestVersion?: string | null;
  pluginAutoUpdateEnabled?: boolean;
  result: HealthCheckResponse;
};

export const COMPUTE_TARGET_SIGNING_FEATURE_FLAG_KEY =
  "compute-target-signing" as const;
export const EXPLICIT_COMPUTE_SELECTION_FEATURE_FLAG_KEY =
  "explicit-compute-selection" as const;
export const HARNESS_SELECTION_FEATURE_FLAG_KEY = "harness-selection" as const;
/**
 * Closed-by-default gate for the System Check "Repair" control (ISS-5389).
 * Web-only: the desktop renderer does not mount a System Check surface, so
 * there is no desktop Labs twin to keep in lockstep.
 */
export const SYSTEM_CHECK_REPAIR_FEATURE_FLAG_KEY =
  "system-check-repair" as const;

/**
 * The System Check Repair gateway operation (ISS-5389).
 *
 * Both live here rather than in each app because THREE independent catalogs
 * have to agree on them: the Desktop approval catalog, the API's desktop-command
 * wire catalog, and the API's per-path authorization at command creation. A
 * repair that is missing from any one of them is rejected as an unmapped
 * operation, or worse, waved through without its ownership check.
 *
 * Repair mutates the target machine (it clears binary-path overrides and runs
 * `claude plugin enable`), so it is deliberately NOT folded into the read-only
 * `health_check` operation id.
 */
export const HEALTH_CHECK_REPAIR_OPERATION_ID = "health_check_repair" as const;
export const HEALTH_CHECK_REPAIR_PATH =
  "/api/gateway/health-check/repair" as const;

export const COMMAND_SIGNING_CAPABILITY_KEY = "commandSigning" as const;
export const COMMAND_SIGNING_REQUIRED_CAPABILITY_KEY =
  "commandSigningRequired" as const;
export const BROWSER_KEY_REVOCATION_OPERATION_ID =
  "browser_key_revoke" as const;
export const BROWSER_KEY_REVOCATION_PATH =
  "/api/gateway/internal/browser-key/revoke" as const;
export const BROWSER_KEY_APPROVAL_REQUEST_OPERATION_ID =
  "browser_key_approval_request" as const;
export const BROWSER_KEY_APPROVAL_REQUEST_PATH =
  "/api/gateway/internal/browser-key/approval-request" as const;
export const BROWSER_KEY_UNREGISTERED_ERROR_CODE =
  "browser_key_unregistered" as const;
export const BROWSER_KEY_REVOCATION_RESERVED_ERROR_CODE =
  "browser_key_revocation_reserved" as const;

export type CommandSignatureFields = {
  signature: string;
  signaturePayload: string;
  publicKeyFingerprint: string;
};

export type BrowserSignedCommandId = string & {
  readonly __brand: "BrowserSignedCommandId";
};

export type RegisterComputeTargetInput = {
  machineName: string;
  platform: string;
  capabilities?: JsonObject;
  supportedOperations: string[];
  allowedDirectories?: string[];
  pluginVersion?: string;
  gatewayId?: string;
  desktopSecurityUpgradeProtocolVersion?: number;
};

export type RegisterComputeTargetResponse = {
  id: string;
  machineName: string;
  isOnline: boolean;
};

export type UpdateComputeTargetInput = {
  machineName?: string;
  platform?: string;
  capabilities?: JsonObject;
  supportedOperations?: string[];
  gatewayId?: string;
  desktopSecurityUpgradeProtocolVersion?: number;
  selectedHarness?: HarnessType;
};

export type ComputeTargetHeartbeatResponse = {
  ok: true;
};

export type RelayOperationDispatchRequest = {
  operationId: string;
  operation: string;
  params: JsonValue;
  streaming: boolean;
};

export type RelayResultIngestRequest =
  | {
      operationId: string;
      result: JsonValue;
      sequence?: number;
    }
  | {
      operationId: string;
      event: JsonValue;
      done?: boolean;
      error?: string;
      sequence?: number;
    };

export const DesktopCommandStatus = {
  Queued: "queued",
  Accepted: "accepted",
  Running: "running",
  Done: "done",
  Failed: "failed",
  Cancelled: "cancelled",
  Expired: "expired",
} as const;
export type DesktopCommandStatus =
  (typeof DesktopCommandStatus)[keyof typeof DesktopCommandStatus];

export type DesktopCommandEventType =
  | "status"
  | "chunk"
  | "result"
  | "error"
  | "done";

export type CreateDesktopCommandInput = {
  commandId?: BrowserSignedCommandId;
  operationId: string;
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  path: string;
  headers?: Record<string, string>;
  query?: Record<string, string | string[]>;
  body?: JsonValue;
  timeoutMs?: number;
  lockKey?: string;
  requiresApproval?: boolean;
  approvalReason?: string;
  idempotencyKey?: string;
  streaming?: boolean;
  signature?: string;
  signaturePayload?: string;
  publicKeyFingerprint?: string;
};

export type PublicKeyRegistrationRequest = {
  publicKeyBase64: string;
  fingerprint: string;
};

/**
 * Target access values emitted by owner-scoped browser-key discovery. The
 * browser-key trust workflow intentionally does not expose shared-target
 * approval access.
 */
export const BrowserKeyTargetAccess = {
  OwnedTarget: "owned_target",
} as const;
export type BrowserKeyTargetAccess =
  (typeof BrowserKeyTargetAccess)[keyof typeof BrowserKeyTargetAccess];

/**
 * Owner-only compute-target context attached to browser-key discovery results.
 * Desktop uses this to reject broad or shared-target reconciliation payloads.
 */
export type BrowserKeyTargetContext = {
  computeTargetId: string;
  gatewayId?: string;
  access: BrowserKeyTargetAccess;
};

/**
 * Reserved command body for removing a browser command-signing key from the
 * owning Desktop. Target fields are additive context for fail-closed Desktop
 * validation and may be absent when an older API dispatches the command.
 */
export type BrowserKeyRevocationCommandBody = {
  publicKeyId: string;
  userId: string;
  fingerprint: string;
  computeTargetId?: string;
  gatewayId?: string;
};

/**
 * Reserved command body for asking the owning Desktop to trust a browser
 * command-signing key. Target fields scope the prompt to the owner's active
 * compute target without broadening trust to shared targets.
 */
export type BrowserKeyApprovalRequestCommandBody = {
  publicKeyId: string;
  userId: string;
  fingerprint: string;
  computeTargetId?: string;
  gatewayId?: string;
};

export type UserPublicKeySummary = {
  id: string;
  userId: string;
  organizationId: string;
  publicKeyBase64: string;
  fingerprint: string;
  createdAt: string;
};

export type OrganizationPublicKeySummary = UserPublicKeySummary & {
  ownerName: string;
  ownerEmail?: string;
  /**
   * Present only when the listing request was scoped to an owned compute
   * target. Absence can mean an older API response or a compatibility fallback.
   */
  targetContext?: BrowserKeyTargetContext;
};

export type CreateDesktopCommandResponse = {
  commandId: string;
  status: DesktopCommandStatus;
  deduped?: boolean;
};

export type DesktopCommandSummary = {
  commandId: string;
  computeTargetId: string;
  operationId: string;
  status: DesktopCommandStatus;
  error?: string;
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
  lastSequenceAcked: number;
  idempotencyKey?: string;
};

export type DesktopCommandEvent = {
  commandId: string;
  sequence: number;
  eventType: DesktopCommandEventType;
  data: JsonValue;
  createdAt: string;
};

export const computeTargetConflictBodyValidator = z.object({
  error: z.literal("multiple_targets"),
  message: z.string(),
  availableTargets: z.array(
    z.object({
      id: z.string(),
      machineName: z.string(),
      status: z.string(),
    })
  ),
});

// The `"multiple_targets"` variant of the 409 compute-target conflict union.
// The `"backend_mismatch"` variant is `BackendMismatchBody`, re-exported from
// @closedloop-ai/loops-api at the top of this file. Future 409 variants should
// be added to the shared contract and unioned for exhaustive client handling.
export type ComputeTargetConflictBody = z.infer<
  typeof computeTargetConflictBodyValidator
>;

// Compute preference

export const ComputePreference = {
  Local: "LOCAL",
  Cloud: "CLOUD",
} as const;
export type ComputePreference =
  (typeof ComputePreference)[keyof typeof ComputePreference];

export type ComputePreferenceResponse = {
  preferredComputeMode: ComputePreference;
  computeTargetId?: string;
  /** True only when the user has persisted an explicit Cloud or Local choice. */
  isExplicit?: boolean;
  /**
   * The user's persisted Cloud-launch harness. Omitted when unset (the client
   * falls back to the Claude default via `parseSelectedHarness(null)`). Distinct
   * from a ComputeTarget's per-row `selectedHarness`, which governs Local.
   */
  selectedHarness?: HarnessType;
};

export type SetComputePreferenceRequest = {
  mode: ComputePreference;
  computeTargetId?: string;
  /** Cloud-launch harness to persist on `User.preferredHarness`. */
  selectedHarness?: HarnessType;
};

export const ComputePreferenceRequiredError =
  "compute_preference_required" as const;
export const ComputePreferenceRequiredMessage =
  "Select Cloud or a local compute target before starting a loop." as const;
export type ComputePreferenceRequiredBody = {
  error: typeof ComputePreferenceRequiredError;
  message: typeof ComputePreferenceRequiredMessage;
};

export type SetComputeTargetSharingResponse = {
  id: string;
  isSharedWithOrg: boolean;
};

export const DESKTOP_SECURITY_UPGRADE_OPERATION_ID =
  "desktop_security_upgrade" as const;

export type StartDesktopSecurityUpgradeResponse = {
  commandId: string;
  expiresAt: string;
};

export type DesktopSecurityUpgradeErrorCode =
  | "SESSION_REQUIRED"
  | "TARGET_NOT_FOUND"
  | "TARGET_NOT_UPGRADEABLE"
  | "UPGRADE_ATTEMPT_CREATE_FAILED"
  | "UPGRADE_COMMAND_DISPATCH_FAILED";

export type DesktopSecurityUpgradeErrorBody = {
  code: DesktopSecurityUpgradeErrorCode;
  retryable: boolean;
};

export const UPDATE_AND_RESTART_OPERATION_ID = "update-and-restart" as const;

export function isTerminalStatus(status: DesktopCommandStatus): boolean {
  return (
    status === DesktopCommandStatus.Done ||
    status === DesktopCommandStatus.Failed ||
    status === DesktopCommandStatus.Cancelled ||
    status === DesktopCommandStatus.Expired
  );
}

export const DesktopHelloNackReason = {
  ComputeTargetRegisterFailed: "compute_target_register_failed",
  ComputeTargetUpdateFailed: "compute_target_update_failed",
  OnlineStateUpdateFailed: "online_state_update_failed",
  PendingCommandsLookupFailed: "pending_commands_lookup_failed",
  InternalError: "internal_error",
} as const;
export type DesktopHelloNackReason =
  (typeof DesktopHelloNackReason)[keyof typeof DesktopHelloNackReason];

export const HarnessType = {
  Claude: "claude",
  Codex: "codex",
} as const;
export type HarnessType = (typeof HarnessType)[keyof typeof HarnessType];

export const setComputePreferenceRequestValidator = z.object({
  mode: z.enum(ComputePreference),
  computeTargetId: z.string().uuid().optional(),
  selectedHarness: z.enum(HarnessType).optional(),
});

export function isMcpProviderAvailable(
  availability: McpProviderAvailability
): boolean {
  if ("available" in availability) {
    return availability.available;
  }
  return availability.closedloopAvailable;
}

/** The CLI check row whose presence proves a harness can actually be run. */
const HARNESS_CLI_CHECK_IDS: Record<HarnessType, string> = {
  [HarnessType.Claude]: CLAUDE_CLI_CHECK_ID,
  [HarnessType.Codex]: CODEX_CLI_CHECK_ID,
};

/**
 * What the gateway's CLI row says about `harness`, or `undefined` when it sent
 * no such row at all.
 *
 * The three states are deliberately distinct. `false` is EVIDENCE the harness
 * cannot launch; `undefined` is the ABSENCE of evidence, and only the latter
 * may fall back to the MCP signal. Collapsing them into one boolean is what
 * let a snapshot saying `Claude CLI ✗` still derive Claude as available.
 *
 * `checks` is declared non-optional, but this reads a parsed wire payload, so a
 * version-skewed or truncated response can still arrive without it.
 */
function harnessCliOutcome(
  healthCheck: HealthCheckResponse,
  harness: HarnessType
): boolean | undefined {
  const checkId = HARNESS_CLI_CHECK_IDS[harness];
  const row = (healthCheck.checks ?? []).find((check) => check.id === checkId);
  return row === undefined ? undefined : row.passed;
}

/** Whether the gateway reported a connected MCP server for `harness`. */
function hasAvailableHarnessMcp(
  healthCheck: HealthCheckResponse,
  harness: HarnessType
): boolean {
  const availability = healthCheck.mcpServers?.[harness];
  return Boolean(availability && isMcpProviderAvailable(availability));
}

/**
 * Derive which harness types are available from a health check response.
 *
 * A harness is available when its CLI is installed and passing. The matching
 * MCP server is an OPTIONAL enhancement — it is how an already-running agent
 * talks back to the platform, not what makes the harness runnable — and the
 * System Check renders both MCP rows `required: false` for exactly that reason.
 *
 * Before ISS-5687 this read `mcpServers` alone, so a machine reporting
 * `Claude CLI ✓` and `Codex CLI ✓` alongside two unconfigured (optional) MCP
 * entries derived ZERO harnesses and the picker rendered "No AI harness
 * available" — self-contradicting on its face, and the reason a purely optional
 * config gap read as a dead compute target.
 *
 * The MCP signal is a FALLBACK, not an alternative: it is consulted only when
 * the snapshot carries no CLI row for that harness, so a gateway too old to
 * emit the CLI rows under these ids still derives what it did before rather
 * than regressing to an empty list. Once a CLI row exists its verdict is
 * final — a snapshot that says `Claude CLI ✗` alongside a connected Claude MCP
 * server must NOT offer Claude, or auto-selection hands the user a harness the
 * same snapshot already proved cannot launch.
 */
export function deriveAvailableHarnesses(
  healthCheck: HealthCheckResponse
): HarnessType[] {
  return Object.values(HarnessType).filter((harness) => {
    const cliOutcome = harnessCliOutcome(healthCheck, harness);
    return cliOutcome ?? hasAvailableHarnessMcp(healthCheck, harness);
  });
}

/**
 * Storage schema version of a persisted System Check snapshot
 * (`ComputeTargetHealthCheck.schemaVersion`).
 *
 * Bumped to 2 by ISS-5811. Version 1 rows were written by an API build whose
 * validator had never heard of `severity`, so every row in them had the field
 * STRIPPED on the way into storage — and a stripped `severity` is not a neutral
 * loss: `resolveCheckSeverity` falls back to `!passed → error`, so an
 * undeterminable plugin row reads back as a proven failure and keeps blocking
 * the command. Plugin rows sit in the one-day default freshness window
 * (`HEALTH_CHECK_DEFAULT_FRESHNESS_MS`), so without a version signal a snapshot
 * written moments before the deploy would go on blocking for up to 24h after
 * the fix shipped.
 *
 * Consumers treat a snapshot BELOW this version as unusable rather than stale
 * data to render — falling through to a live check is always safe, where
 * trusting a v1 row reproduces the outage this ticket exists to end.
 */
export const HEALTH_CHECK_SNAPSHOT_SCHEMA_VERSION = 2;

/**
 * Whether `target` belongs to the viewer who asked for it.
 *
 * Deliberately NOT `target.userId === <the signed-in user's id>`: those are two
 * different identity domains. `ComputeTarget.userId` is the internal `User.id`
 * UUID (`@db.Uuid`), while a browser only ever holds the Clerk user id
 * (`useAuth().userId`, `user_2…`) — the API resolves one to the other and keeps
 * them as separate `user.id` / `user.clerkId` fields. Comparing them is false
 * for every real user, so such a check silently reports that nobody owns
 * anything rather than failing loudly.
 *
 * The viewer-scoped list response already answers this server-side:
 * `toComputeTarget` populates `ownerName` ONLY for targets the viewer does not
 * own, so its absence IS the ownership signal, and it is the signal the compute
 * target picker, the settings card and the pre-loop system check already read.
 *
 * Scoped to viewer-annotated list responses (`GET /compute-targets`);
 * single-target register/update responses carry no viewer context.
 */
export function isComputeTargetOwnedByViewer(
  target: Pick<ComputeTarget, "ownerName">
): boolean {
  return !target.ownerName;
}
