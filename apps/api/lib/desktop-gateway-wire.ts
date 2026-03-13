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
    !Number.isFinite(payload.maxInFlightCommands) ||
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
  streaming?: boolean;
  createdAt: string;
}): WireCommandPayload {
  return {
    commandId: command.commandId,
    operationId: resolveOperationId(command.path) ?? command.operationId,
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
    streaming: command.streaming === true ? true : undefined,
  };
}

export function toWireCommandFromRelayOperation(operation: {
  operationId: string;
  params: JsonValue;
  streaming?: boolean;
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

  // Resolve the semantic operationId that Electron expects from the path.
  // The browser sends a random UUID as operationId, but Electron requires
  // the resolved name (e.g. "health_check", "symphony_launch").
  const operationId = resolveOperationId(path) ?? operation.operationId;

  return {
    commandId,
    operationId,
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
    streaming: operation.streaming === true ? true : undefined,
  };
}

export function emitCommand(socket: Socket, command: WireCommandPayload): void {
  socket.emit("desktop.command", toEnvelope(command));
}

/**
 * Exact-match path → operationId.
 * Must stay in sync with Electron's `resolveOperationId()` in
 * `apps/desktop/src/main/app.ts`.
 */
const EXACT_OPERATION_IDS: Record<string, string> = {
  "/api/engineer/symphony/launch": "symphony_launch",
  "/api/engineer/symphony/kill": "symphony_kill",
  "/api/engineer/symphony/loop": "symphony_loop",
  "/api/engineer/symphony/loop/kill": "symphony_loop_kill",
  "/api/engineer/symphony/sessions": "symphony_sessions",
  "/api/engineer/terminal-chat": "terminal_chat",
  "/api/engineer/ticket-chat": "ticket_chat",
  "/api/engineer/run-viewer-chat": "run_viewer_chat",
  "/api/engineer/health-check": "health_check",
  "/api/engineer/repos": "repos_config",
  "/api/engineer/learnings": "learnings",
  "/api/engineer/directories": "filesystem",
  "/api/engineer/files/search": "filesystem",
  "/api/engineer/git/user": "git_pr",
};

/**
 * Prefix-match path → operationId (checked in order, first match wins).
 * Order matters: more-specific prefixes must come before less-specific ones.
 */
const PREFIX_OPERATION_IDS: [string, string][] = [
  ["/api/engineer/symphony/status/", "symphony_status"],
  ["/api/engineer/symphony/chat-history/", "symphony_chat_history"],
  ["/api/engineer/symphony/chat/", "symphony_chat"],
  ["/api/engineer/symphony/comment-chat/", "symphony_comment_chat"],
  ["/api/engineer/symphony/commit-message/", "symphony_commit_message"],
  ["/api/engineer/symphony/plan/", "symphony_plan"],
  ["/api/engineer/symphony/judges/", "symphony_judges"],
  ["/api/engineer/symphony/logs/", "symphony_logs"],
  ["/api/engineer/symphony/pending-learnings", "learnings"],
  ["/api/engineer/symphony/process-all-learnings", "learnings"],
  ["/api/engineer/symphony/process-learnings", "learnings"],
  ["/api/engineer/codex/argue/", "codex_argue"],
  ["/api/engineer/codex/", "codex_review"],
  ["/api/engineer/git/pr", "git_pr"],
  ["/api/engineer/git", "git_action"],
  ["/api/engineer/deploy", "deploy"],
  ["/api/engineer/run-viewer-extract", "filesystem"],
];

/**
 * Resolve the semantic operationId that Electron expects for a given
 * `/api/engineer/*` path.  This must stay in sync with the Electron
 * desktop app's `resolveOperationId()` in `apps/desktop/src/main/app.ts`.
 */
export function resolveOperationId(pathname: string): string | null {
  if (!pathname.startsWith("/api/engineer/")) {
    return null;
  }

  const exact = EXACT_OPERATION_IDS[pathname];
  if (exact) {
    return exact;
  }

  for (const [prefix, operationId] of PREFIX_OPERATION_IDS) {
    if (pathname.startsWith(prefix)) {
      return operationId;
    }
  }

  return null;
}
