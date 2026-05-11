import type { JsonObject, JsonValue } from "./common";

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
  /** Present when the target belongs to another user (shared target). */
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

export type CheckResult = {
  id: string;
  label: string;
  required: boolean;
  passed: boolean;
  version?: string;
  error?: string;
  remediation?: string;
  debug?: CheckResultDebug;
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
  mcpServers?: {
    claude: McpProviderAvailability;
    codex: McpProviderAvailability;
  };
};

export type ComputeTargetHealthCheckSnapshot = {
  id: string;
  organizationId: string;
  computeTargetId: string;
  checkedAt: Date;
  expectedMcpUrl: string | null;
  latestVersion: string | null;
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
  result: HealthCheckResponse;
};

export const COMPUTE_TARGET_SIGNING_FEATURE_FLAG_KEY =
  "compute-target-signing" as const;

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

export type ComputeTargetServerCapabilities = {
  computeTargetSigning?: boolean;
};

export type CommandSignatureFields = {
  signature: string;
  signaturePayload: string;
  publicKeyFingerprint: string;
};

export type BrowserSignedCommandId = string & {
  readonly __brand: "BrowserSignedCommandId";
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

export type BrowserKeyRevocationCommandBody = {
  publicKeyId: string;
  userId: string;
  fingerprint: string;
};

export type BrowserKeyApprovalRequestCommandBody = {
  publicKeyId: string;
  userId: string;
  fingerprint: string;
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

export type ComputeTargetConflictBody = {
  error: "multiple_targets";
  message: string;
  availableTargets: Array<{ id: string; machineName: string; status: string }>;
};

/**
 * Discriminated union for 409 Conflict responses on compute-target mismatches.
 *
 * Each variant is identified by its `error` discriminant field:
 * - `"multiple_targets"` (ComputeTargetConflictBody): multiple online targets ambiguously match
 * - `"backend_mismatch"` (BackendMismatchBody): the resolved target differs from the backend
 *   used by the artifact's last completed loop; caller may retry with `backendOverride: true`
 *
 * Future 409 variants should be added here and unioned into a shared
 * `ComputeTargetConflict` type alias for exhaustive handling on the client.
 */
export type BackendMismatchBody = {
  error: "backend_mismatch";
  message: string;
  originalComputeTargetId: string | null;
  originalComputeTargetName: string | null;
  preferredComputeTargetId: string | null;
  documentId: string;
};

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
};

export type SetComputePreferenceRequest = {
  mode: ComputePreference;
  computeTargetId?: string;
};

export type SetComputeTargetSharingRequest = {
  isSharedWithOrg: boolean;
};

export type SetComputeTargetSharingResponse = {
  id: string;
  isSharedWithOrg: boolean;
};

export const DESKTOP_SECURITY_UPGRADE_OPERATION_ID =
  "desktop_security_upgrade" as const;

export type StartDesktopSecurityUpgradeRequest = {
  webAppOrigin: string;
};

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
