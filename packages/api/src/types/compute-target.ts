import type { JsonObject, JsonValue } from "./common";

export type ComputeTarget = {
  id: string;
  organizationId: string;
  userId: string;
  machineName: string;
  platform: string;
  capabilities: JsonObject;
  supportedOperations: string[];
  lastSeenAt: Date;
  isOnline: boolean;
  isSharedWithOrg: boolean;
  /** Present when the target belongs to another user (shared target). */
  ownerName?: string;
  createdAt: Date;
  updatedAt: Date;
};

export type RegisterComputeTargetInput = {
  machineName: string;
  platform: string;
  capabilities?: JsonObject;
  supportedOperations: string[];
  allowedDirectories?: string[];
  pluginVersion?: string;
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

export type DesktopCommandStatus =
  | "queued"
  | "accepted"
  | "running"
  | "done"
  | "failed"
  | "cancelled"
  | "expired";

export type DesktopCommandEventType =
  | "status"
  | "chunk"
  | "result"
  | "error"
  | "done";

export type CreateDesktopCommandInput = {
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
  artifactId: string;
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
};

export type SetComputePreferenceRequest = {
  mode: ComputePreference;
};

export type SetComputeTargetSharingRequest = {
  isSharedWithOrg: boolean;
};

export type SetComputeTargetSharingResponse = {
  id: string;
  isSharedWithOrg: boolean;
};
