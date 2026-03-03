import { randomUUID } from "node:crypto";
import type { JsonValue } from "@repo/api/src/types/common";
import type { DesktopCommandEventType } from "@repo/api/src/types/compute-target";
import type { Socket } from "socket.io";
import { isRecord } from "@/lib/type-guards";
import {
  type DesktopCommandAckPayload,
  type DesktopCommandEventPayload,
  type DesktopHelloPayload,
  type Envelope,
  PROTOCOL_VERSION,
  type WireCommandPayload,
} from "./desktop-gateway-types";

export function isStringArray(value: unknown): value is string[] {
  return (
    Array.isArray(value) && value.every((entry) => typeof entry === "string")
  );
}

export function isDesktopCommandEventType(
  value: unknown
): value is DesktopCommandEventType {
  return (
    value === "status" ||
    value === "chunk" ||
    value === "result" ||
    value === "error" ||
    value === "done"
  );
}

export function isTerminalEventData(data: JsonValue): boolean {
  return isRecord(data) && data.terminal === true;
}

export function toEnvelope<T extends Record<string, unknown>>(
  payload: T
): Envelope<T> {
  return {
    ...payload,
    protocolVersion: PROTOCOL_VERSION,
    messageId: randomUUID(),
    timestamp: new Date().toISOString(),
  };
}

export function parseHelloPayload(
  payload: unknown
): DesktopHelloPayload | null {
  if (!isRecord(payload)) {
    return null;
  }
  if (
    typeof payload.machineName !== "string" ||
    typeof payload.platform !== "string" ||
    typeof payload.pluginVersion !== "string" ||
    !isStringArray(payload.supportedOperations) ||
    typeof payload.maxInFlightCommands !== "number" ||
    payload.maxInFlightCommands < 1
  ) {
    return null;
  }

  return {
    computeTargetId:
      typeof payload.computeTargetId === "string"
        ? payload.computeTargetId
        : undefined,
    machineName: payload.machineName,
    platform: payload.platform,
    pluginVersion: payload.pluginVersion,
    supportedOperations: payload.supportedOperations,
    maxInFlightCommands: Math.floor(payload.maxInFlightCommands),
    allowedDirectoriesHash:
      typeof payload.allowedDirectoriesHash === "string"
        ? payload.allowedDirectoriesHash
        : undefined,
    capabilities: isRecord(payload.capabilities)
      ? payload.capabilities
      : undefined,
  };
}

export function parseCommandAckPayload(
  payload: unknown
): DesktopCommandAckPayload | null {
  if (!isRecord(payload)) {
    return null;
  }
  if (
    typeof payload.commandId !== "string" ||
    typeof payload.accepted !== "boolean"
  ) {
    return null;
  }
  return {
    commandId: payload.commandId,
    accepted: payload.accepted,
    reason: typeof payload.reason === "string" ? payload.reason : undefined,
  };
}

export function parseCommandEventPayload(
  payload: unknown
): DesktopCommandEventPayload | null {
  if (!isRecord(payload)) {
    return null;
  }
  if (
    typeof payload.commandId !== "string" ||
    typeof payload.sequence !== "number" ||
    payload.sequence < 1 ||
    !Number.isInteger(payload.sequence) ||
    !isDesktopCommandEventType(payload.eventType)
  ) {
    return null;
  }
  return {
    commandId: payload.commandId,
    sequence: payload.sequence,
    eventType: payload.eventType,
    data: (payload.data as JsonValue | undefined) ?? null,
  };
}

export function normalizeMethod(
  value: unknown
): WireCommandPayload["method"] | null {
  if (
    value === "GET" ||
    value === "POST" ||
    value === "PUT" ||
    value === "PATCH" ||
    value === "DELETE"
  ) {
    return value;
  }
  return null;
}

export function toStringRecord(
  value: unknown
): Record<string, string> | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const entries = Object.entries(value).filter(
    (entry): entry is [string, string] => typeof entry[1] === "string"
  );
  if (entries.length === 0) {
    return undefined;
  }
  return Object.fromEntries(entries);
}

export function splitPathAndQuery(pathWithQuery: string): {
  path: string;
  query?: Record<string, string | string[]>;
} {
  const url = new URL(pathWithQuery, "http://desktop-gateway.local");
  const groupedQuery = new Map<string, string[]>();
  for (const [key, value] of url.searchParams.entries()) {
    const values = groupedQuery.get(key) ?? [];
    values.push(value);
    groupedQuery.set(key, values);
  }

  if (groupedQuery.size === 0) {
    return { path: url.pathname };
  }

  return {
    path: url.pathname,
    query: Object.fromEntries(
      Array.from(groupedQuery.entries()).map(([key, values]) => [
        key,
        values.length === 1 ? values[0] : values,
      ])
    ),
  };
}

export function toWireCommandFromStore(command: {
  commandId: string;
  operationId: string;
  method: WireCommandPayload["method"];
  path: string;
  headers?: Record<string, string>;
  query?: Record<string, string | string[]>;
  body?: JsonValue;
  timeoutMs?: number;
  lockKey?: string;
  requiresApproval?: boolean;
  approvalReason?: string;
  createdAt: string;
}): WireCommandPayload {
  return {
    commandId: command.commandId,
    operationId: command.operationId,
    method: command.method,
    path: command.path,
    headers: command.headers,
    query: command.query,
    body: command.body,
    timeoutMs: command.timeoutMs,
    queuedAt: command.createdAt,
    lockKey: command.lockKey,
    requiresApproval: command.requiresApproval,
    approvalReason: command.approvalReason,
  };
}

export function toWireCommandFromRelayOperation(operation: {
  operationId: string;
  params: JsonValue;
}): WireCommandPayload | null {
  const params = isRecord(operation.params) ? operation.params : {};
  const request = isRecord(params.request) ? params.request : {};
  const rawPath = typeof request.path === "string" ? request.path : null;
  const method = normalizeMethod(request.method);
  const commandId =
    typeof params.commandId === "string" ? params.commandId : null;

  if (!(rawPath && method && commandId)) {
    return null;
  }

  const { path, query } = splitPathAndQuery(rawPath);
  if (!path.startsWith("/api/engineer/")) {
    return null;
  }

  return {
    commandId,
    operationId: operation.operationId,
    method,
    path,
    headers: toStringRecord(request.headers),
    query,
    body: ("body" in request ? (request.body as JsonValue) : null) as JsonValue,
    timeoutMs:
      typeof params.timeoutMs === "number" ? params.timeoutMs : undefined,
    lockKey: typeof params.lockKey === "string" ? params.lockKey : undefined,
    requiresApproval:
      typeof params.requiresApproval === "boolean"
        ? params.requiresApproval
        : undefined,
    approvalReason:
      typeof params.approvalReason === "string"
        ? params.approvalReason
        : undefined,
  };
}

export function emitCommand(socket: Socket, command: WireCommandPayload): void {
  socket.emit("desktop.command", toEnvelope(command));
}
