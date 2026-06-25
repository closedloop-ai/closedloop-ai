import type { JsonValue } from "@repo/api/src/types/common";
import type {
  DesktopCommandEventType,
  DesktopHelloNackReason,
} from "@repo/api/src/types/compute-target";
import type { ApiKeySource } from "@repo/database";
import type { Server } from "socket.io";

export const PROTOCOL_VERSION = "1";

/** Maximum time (ms) any single async operation may take during the hello handshake. */
export const HELLO_OPERATION_TIMEOUT_MS = 5000;

export type DesktopAuthContext = {
  organizationId: string;
  userId: string;
  clerkUserId?: string | null;
  apiKeySource: ApiKeySource;
  apiKeyGatewayId: string | null;
  apiKeyBoundPublicKey: string | null;
};

export type DesktopHelloPayload = {
  computeTargetId?: string;
  gatewayId?: string;
  desktopSecurityUpgradeProtocolVersion?: number;
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
  clerkUserId?: string | null;
  sessionId: string;
  pluginVersion?: string;
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
  streaming?: boolean;
  signature?: string;
  signaturePayload?: string;
  publicKeyFingerprint?: string;
};

export type DesktopHelloNackPayload = {
  reason: DesktopHelloNackReason;
  message?: string;
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

/**
 * Adds optional correlation fields to any payload type for command dispatch tracking.
 *
 * - `requestId`: Unique identifier for the originating HTTP request, useful for
 *   end-to-end tracing across the relay pipeline.
 * - `gatewaySessionId`: Session correlation identifier for the desktop gateway
 *   WebSocket session. Treat with session-token sensitivity — do not log or
 *   expose in client-facing responses.
 * - `computeTargetId`: The target compute node this command is routed to,
 *   enabling fan-out disambiguation when multiple targets are connected.
 */
export type WithCorrelation<T> = T & {
  requestId?: string;
  gatewaySessionId?: string;
  computeTargetId?: string;
};
