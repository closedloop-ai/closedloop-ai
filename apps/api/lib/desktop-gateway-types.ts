import type { JsonValue } from "@repo/api/src/types/common";
import type { DesktopCommandEventType } from "@repo/api/src/types/compute-target";
import type { Server } from "socket.io";

export const PROTOCOL_VERSION = "1";

export type DesktopAuthContext = {
  organizationId: string;
  userId: string;
};

export type DesktopHelloPayload = {
  computeTargetId?: string;
  machineName: string;
  platform: string;
  pluginVersion: string;
  supportedOperations: string[];
  maxInFlightCommands: number;
  allowedDirectoriesHash?: string;
  capabilities?: Record<string, unknown>;
};

export type SocketConnectionContext = {
  targetId: string;
  organizationId: string;
  userId: string;
  sessionId: string;
  unsubscribeOperations: () => void;
  unsubscribeConnectionClose: () => void;
  heartbeatTimer: ReturnType<typeof setInterval>;
};

export type WireCommandPayload = {
  commandId: string;
  operationId: string;
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  path: string;
  headers?: Record<string, string>;
  query?: Record<string, string | string[]>;
  body?: JsonValue;
  timeoutMs?: number;
  queuedAt?: string;
  lockKey?: string;
  requiresApproval?: boolean;
  approvalReason?: string;
};

export type Envelope<T> = T & {
  protocolVersion: typeof PROTOCOL_VERSION;
  messageId: string;
  timestamp: string;
};

export type DesktopCommandAckPayload = {
  commandId: string;
  accepted: boolean;
  reason?: string;
};

export type DesktopCommandEventPayload = {
  commandId: string;
  sequence: number;
  eventType: DesktopCommandEventType;
  data: JsonValue;
};

export type DesktopGatewaySocketServer = {
  io: Server;
  close: () => Promise<void>;
};

export type GatewaySocketData = {
  authContext?: DesktopAuthContext;
  authDurationMs?: number;
  connectStartedAt?: number;
};
