import { randomUUID } from "node:crypto";
import {
  isDesktopApiPath,
  normalizeDesktopApiPath,
} from "@repo/api/src/desktop-api-namespace";
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
  type WithCorrelation,
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
    gatewayId:
      typeof payload.gatewayId === "string" ? payload.gatewayId : undefined,
    desktopSecurityUpgradeProtocolVersion:
      payload.desktopSecurityUpgradeProtocolVersion === 1 ? 1 : undefined,
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
  if (!isDesktopApiPath(path)) {
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

export function emitCommand(
  socket: Socket,
  command: WithCorrelation<WireCommandPayload>
): void {
  socket.emit("desktop.command", toEnvelope(command));
}

/**
 * Exact-match path → operationId.
 * Must stay in sync with Electron's `resolveOperationId()` in
 * `apps/desktop/src/main/app.ts`.
 */
export const EXACT_OPERATION_IDS: Record<string, string> = {
  "/api/gateway/symphony/launch": "symphony_launch",
  "/api/gateway/symphony/kill": "symphony_kill",
  "/api/gateway/symphony/loop": "symphony_loop",
  "/api/gateway/symphony/loop/kill": "symphony_loop_kill",
  "/api/gateway/symphony/status": "symphony_status",
  "/api/gateway/symphony/sessions": "symphony_sessions",
  "/api/gateway/symphony/record-learning-use": "learnings",
  "/api/gateway/terminal-chat": "terminal_chat",
  "/api/gateway/ticket-chat": "ticket_chat",
  "/api/gateway/run-viewer-chat": "run_viewer_chat",
  "/api/gateway/health-check": "health_check",
  "/api/gateway/version": "health_check",
  "/api/gateway/repos": "repos_config",
  "/api/gateway/learnings": "learnings",
  "/api/gateway/directories": "filesystem",
  "/api/gateway/files/search": "filesystem",
  "/api/gateway/git/user": "git_pr",
  "/api/gateway/git/branch-worktree": "git_branch_worktree",
};

/**
 * Prefix-match path → operationId (checked in order, first match wins).
 * Order matters: more-specific prefixes must come before less-specific ones.
 */
export const PREFIX_OPERATION_IDS: [string, string][] = [
  ["/api/gateway/symphony/status/", "symphony_status"],
  ["/api/gateway/symphony/plan-loop/", "symphony_plan_loop"],
  ["/api/gateway/symphony/chat-history/", "symphony_chat_history"],
  ["/api/gateway/symphony/chat/", "symphony_chat"],
  ["/api/gateway/symphony/comment-chat/", "symphony_comment_chat"],
  ["/api/gateway/symphony/commit-message/", "symphony_commit_message"],
  ["/api/gateway/symphony/plan/", "symphony_plan"],
  ["/api/gateway/symphony/judges/", "symphony_judges"],
  ["/api/gateway/symphony/logs/", "symphony_logs"],
  ["/api/gateway/symphony/sessions/", "symphony_sessions"],
  ["/api/gateway/symphony/attachments/", "filesystem"],
  ["/api/gateway/symphony/upload/", "filesystem"],
  ["/api/gateway/symphony/pending-learnings", "learnings"],
  ["/api/gateway/symphony/process-all-learnings", "learnings"],
  ["/api/gateway/symphony/process-learnings", "learnings"],
  ["/api/gateway/symphony/extract-learnings", "learnings"],
  ["/api/gateway/symphony/learnings-status/", "learnings"],
  ["/api/gateway/codex/argue/", "codex_argue"],
  ["/api/gateway/codex/", "codex_review"],
  ["/api/gateway/work-directory/", "filesystem"],
  ["/api/gateway/git/pr", "git_pr"],
  ["/api/gateway/git", "git_action"],
  ["/api/gateway/deploy", "deploy"],
  ["/api/gateway/run-viewer-extract", "filesystem"],
];

/**
 * Resolve the semantic operationId that Electron expects for a given
 * desktop API path. This must stay in sync with the Electron
 * desktop app's `resolveOperationId()` in `apps/desktop/src/main/app.ts`.
 */
export function resolveOperationId(pathname: string): string | null {
  const normalizedPath = normalizeDesktopApiPath(pathname);
  if (!normalizedPath) {
    return null;
  }

  const exact = EXACT_OPERATION_IDS[normalizedPath];
  if (exact) {
    return exact;
  }

  for (const [prefix, operationId] of PREFIX_OPERATION_IDS) {
    if (normalizedPath.startsWith(prefix)) {
      return operationId;
    }
  }

  return null;
}
