import type { JsonValue } from "@repo/api/src/types/common";
import type {
  ComputeTargetServerCapabilities,
  DesktopCommandEventType,
  DesktopHelloNackReason,
} from "@repo/api/src/types/compute-target";
import type { ApiKeySource } from "@repo/database";
import type { Server } from "socket.io";

export const PROTOCOL_VERSION = "1";

/** Maximum time (ms) any single async operation may take during the hello handshake. */
export const HELLO_OPERATION_TIMEOUT_MS = 5000;

/**
 * The most in-flight commands the cloud will honour from a client-declared
 * ceiling, whichever lane declared it.
 *
 * The declared value is not advice: it becomes the `take` of the dispatch drain's
 * queue read and then the width of a `Promise.all` that opens one outbound relay
 * POST per row. Unbounded, a single hello turns the next command completion into
 * a fan-out the size of the whole queued backlog — the burst the drain exists to
 * prevent. Bounding it here rather than at either call site keeps the socket lane
 * and the relay lane agreeing on one number.
 *
 * 32x the stock desktop's declared 2 (`MAX_IN_FLIGHT_COMMANDS`,
 * `apps/desktop/src/main/app.ts`), so a legitimately higher-throughput client is
 * not throttled, while the fan-out stays bounded.
 */
export const MAX_IN_FLIGHT_COMMANDS_CEILING = 64;

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
  /** Electron app version (from app.getVersion()), distinct from the wire protocol version. */
  desktopClientVersion?: string;
  /** Gateway wire-protocol version, distinct from the Socket.IO envelope protocolVersion. */
  gatewayProtocolVersion?: string;
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
  serverCapabilities?: ComputeTargetServerCapabilities;
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

/**
 * Cadence at which a DIRECTLY connected desktop refreshes `lastSeenAt` — the
 * per-socket heartbeat timer in `desktop-gateway-socket-server`.
 *
 * Declared here rather than beside that timer because `COMPUTE_TARGET_STALE_MS`
 * is a timeout over it and has to outlast the slowest periodic writer of
 * `lastSeenAt`. The relay transport paces its own writer from a separate knob
 * (`RELAY_PRESENCE_HEARTBEAT_INTERVAL_MS`) that only happens to hold the same
 * value, so a cadence private to the socket module left the cutoff derived from
 * the OTHER transport's knob: retuning this one would flip live direct targets
 * offline between their own check-ins with nothing red.
 */
export const SOCKET_HEARTBEAT_INTERVAL_MS = 30_000;
