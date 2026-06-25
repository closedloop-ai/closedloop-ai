import type {
  BackendMismatchBody as SharedBackendMismatchBody,
  CheckResult as SharedCheckResult,
  CheckResultDebug as SharedCheckResultDebug,
  ComputeTarget as SharedComputeTarget,
  ComputeTargetSecurity as SharedComputeTargetSecurity,
  ComputeTargetServerCapabilities as SharedComputeTargetServerCapabilities,
  DesktopSecurityReason as SharedDesktopSecurityReason,
  RemediationLink as SharedRemediationLink,
} from "@closedloop-ai/loops-api/compute-target";
import {
  DesktopSecurityStatus as sharedDesktopSecurityStatus,
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
export const PluginUpdateOutcome = sharedPluginUpdateOutcome;
export type PluginUpdateOutcome =
  (typeof PluginUpdateOutcome)[keyof typeof PluginUpdateOutcome];
export type RemediationLink = SharedRemediationLink;
export type CheckResult = SharedCheckResult;
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
};

export type LegacyMcpProviderAvailability = {
  closedloopAvailable: boolean;
  checkedAt: string;
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

/**
 * Derive which harness types are available from a health check response.
 * Returns an empty array when mcpServers data is absent.
 */
export function deriveAvailableHarnesses(
  healthCheck: HealthCheckResponse
): HarnessType[] {
  const mcpServers = healthCheck.mcpServers;
  if (!mcpServers) {
    return [];
  }
  const result: HarnessType[] = [];
  if (mcpServers.claude && isMcpProviderAvailable(mcpServers.claude)) {
    result.push(HarnessType.Claude);
  }
  if (mcpServers.codex && isMcpProviderAvailable(mcpServers.codex)) {
    result.push(HarnessType.Codex);
  }
  return result;
}
