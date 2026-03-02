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
