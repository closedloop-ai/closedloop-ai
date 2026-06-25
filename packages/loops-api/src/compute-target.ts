import type { JsonObject } from "./common";

export type ComputeTargetServerCapabilities = {
  computeTargetSigning?: boolean;
  agentSessionSync?: boolean;
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
};

export type BackendMismatchBody = {
  error: "backend_mismatch";
  message: string;
  originalComputeTargetId: string | null;
  originalComputeTargetName: string | null;
  preferredComputeTargetId: string | null;
  documentId: string;
};
