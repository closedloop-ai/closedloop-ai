import { randomUUID } from "node:crypto";
import { isDesktopApiPath } from "@repo/api/src/desktop-api-namespace";
import {
  BranchViewLocalGatewayPath,
  BranchViewLocalOperationId,
} from "@repo/api/src/types/branch-view-local";
import type { JsonValue } from "@repo/api/src/types/common";
import {
  HEALTH_CHECK_REPAIR_OPERATION_ID,
  HEALTH_CHECK_REPAIR_PATH,
  type RelayOperationDispatchRequest,
} from "@repo/api/src/types/compute-target";
import {
  GITHUB_RESYNC_NUDGE_OPERATION_ID,
  GITHUB_RESYNC_NUDGE_PATH,
} from "@repo/api/src/types/github-dirty-scope";
import {
  MEMBER_PACK_INSTALL_OPERATION_ID,
  MEMBER_PACK_INSTALL_PATH,
} from "@repo/api/src/types/member-pack-install";
import { log } from "@repo/observability/log";
import { clampTimerDelayMs } from "@repo/shared-platform/parse-env-ms";
import type { Socket } from "socket.io";
import { z } from "zod";
import { sanitizeApprovalReason } from "@/lib/compute-target-field-limits";
import {
  jsonValueSchema,
  parseJsonObject,
  stringRecordSchema,
} from "@/lib/json-schema";
import { isRecord } from "@/lib/type-guards";
import {
  type DesktopCommandAckPayload,
  type DesktopCommandEventPayload,
  type DesktopHelloPayload,
  type Envelope,
  MAX_IN_FLIGHT_COMMANDS_CEILING,
  PROTOCOL_VERSION,
  type WireCommandPayload,
  type WithCorrelation,
} from "./desktop-gateway-types";

const stringArraySchema = z.array(z.string());
const desktopCommandEventTypeSchema = z.enum([
  "status",
  "chunk",
  "result",
  "error",
  "done",
]);
const commandMethodSchema = z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]);
const helloPayloadSchema = z.object({
  computeTargetId: z.string().optional(),
  gatewayId: z.string().optional(),
  desktopSecurityUpgradeProtocolVersion: z.unknown().optional(),
  // `machineName` and `supportedOperations` are bounded for this lane too, but
  // NOT here: a `safeParse` failure makes `parseHelloPayload` return `null`,
  // and the sole caller answers that with a bare `socket.disconnect(true)` —
  // no log line and no `desktop.hello.nack`. Refusing at the schema would take
  // the over-length hello from "nacked with a named reason plus an error log"
  // to "connection drops, nothing recorded anywhere", which is the exact
  // signal loss the relay lane's bound was written to avoid. Both bounds live
  // in `handleSocketHello` instead, where the socket is in scope and the
  // refusal can carry the same branched nack the relay handler emits.
  machineName: z.string(),
  platform: z.string(),
  pluginVersion: z.string(),
  desktopClientVersion: z.string().optional(),
  gatewayProtocolVersion: z.string().optional(),
  supportedOperations: stringArraySchema,
  maxInFlightCommands: z.number().finite().min(1),
  allowedDirectoriesHash: z.string().optional(),
  capabilities: z.unknown().optional(),
});
const commandAckPayloadSchema = z.object({
  commandId: z.string(),
  accepted: z.boolean(),
  reason: z.string().optional(),
});
const commandEventPayloadSchema = z.object({
  commandId: z.string(),
  sequence: z.number().int().min(1),
  eventType: desktopCommandEventTypeSchema,
  data: jsonValueSchema.optional(),
});

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
  const parsed = helloPayloadSchema.safeParse(payload);
  if (!parsed.success) {
    return null;
  }
  const hello = parsed.data;

  return {
    computeTargetId: hello.computeTargetId,
    gatewayId: hello.gatewayId,
    desktopSecurityUpgradeProtocolVersion:
      hello.desktopSecurityUpgradeProtocolVersion === 1 ? 1 : undefined,
    machineName: hello.machineName,
    platform: hello.platform,
    pluginVersion: hello.pluginVersion,
    desktopClientVersion: hello.desktopClientVersion,
    gatewayProtocolVersion: hello.gatewayProtocolVersion,
    supportedOperations: hello.supportedOperations,
    maxInFlightCommands: clampDeclaredMaxInFlightCommands(
      hello.maxInFlightCommands,
      { machineName: hello.machineName, gatewayId: hello.gatewayId }
    ),
    allowedDirectoriesHash: hello.allowedDirectoriesHash,
    capabilities: parseJsonObject(hello.capabilities) ?? undefined,
  };
}

export function parseCommandAckPayload(
  payload: unknown
): DesktopCommandAckPayload | null {
  const parsed = commandAckPayloadSchema.safeParse(payload);
  return parsed.success ? parsed.data : null;
}

export function parseCommandEventPayload(
  payload: unknown
): DesktopCommandEventPayload | null {
  const parsed = commandEventPayloadSchema.safeParse(payload);
  if (!parsed.success) {
    return null;
  }
  const event = parsed.data;
  return {
    commandId: event.commandId,
    sequence: event.sequence,
    eventType: event.eventType,
    data: event.data ?? null,
  };
}

export function normalizeMethod(
  value: unknown
): WireCommandPayload["method"] | null {
  const parsed = commandMethodSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

export function toStringRecord(
  value: unknown
): Record<string, string> | undefined {
  const parsed = stringRecordSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

export function splitPathAndQuery(pathWithQuery: string): {
  path: string;
  query?: Record<string, string | string[]>;
} | null {
  let url: URL;
  try {
    url = new URL(pathWithQuery, "http://desktop-gateway.local");
  } catch {
    // The path is browser-supplied, so `new URL` can throw TypeError on it. This
    // runs before the namespace guard, so a throw would escape the declared
    // `WireCommandPayload | null` contract of the only caller (ISS-7558).
    return null;
  }
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
    // Clamped again on the way out of the store, not just on the way in. Two
    // things reach a stored `timeoutMs` that the relay mappers never see: the
    // REST create route, whose `createDesktopCommandValidator` bounds the value
    // `.positive()` but sets no ceiling, and any row persisted before ISS-8233.
    // Both replay through here on reconnect, and an already-installed desktop
    // has no clamp of its own — so the cloud has to stay safe on its own.
    timeoutMs: clampTimerDelayMs(command.timeoutMs),
    queuedAt: command.createdAt,
    lockKey: command.lockKey,
    requiresApproval: command.requiresApproval,
    // Sanitized again on the way out of the store for the same reason
    // `timeoutMs` is clamped above: the three producers bound this field on the
    // way IN, but a row persisted before them can still carry an overlong or
    // non-latin-1 reason, and reconnect replays it verbatim. The desktop has no
    // gate of its own yet, so `Headers.set` throws a `TypeError` on
    // `x-desktop-approval-reason` and the whole command is lost on every replay.
    approvalReason: sanitizeApprovalReason(
      command.approvalReason,
      (rejection) => {
        log.warn("toWireCommandFromStore: malformed stored approvalReason", {
          commandId: command.commandId,
          ...rejection,
        });
      }
    ),
    streaming: command.streaming === true ? true : undefined,
  };
}

export function toWireCommandFromRelayOperation(operation: {
  operationId: string;
  params: JsonValue;
  streaming?: boolean;
}): WireCommandPayload | null {
  const rawParams = isRecord(operation.params) ? operation.params : {};
  const rawRequest = isRecord(rawParams.request) ? rawParams.request : {};
  const { body: rawBody, ...requestWithoutBody } = rawRequest;
  const params = parseJsonObject({
    ...rawParams,
    request: requestWithoutBody,
  });
  if (!params) {
    return null;
  }
  const request = parseJsonObject(params.request) ?? {};
  const rawPath = typeof request.path === "string" ? request.path : null;
  const method = normalizeMethod(request.method);
  const commandId =
    typeof params.commandId === "string" ? params.commandId : null;

  if (!(rawPath && method && commandId)) {
    return null;
  }

  const parsedPath = splitPathAndQuery(rawPath);
  if (!parsedPath) {
    return null;
  }

  const { path, query } = parsedPath;
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
    body: jsonValueSchema.safeParse(rawBody).data ?? null,
    // `RelayOperationDispatchRequest.params` is an unvalidated `JsonValue`, so
    // nothing upstream has bounded this; clamp here, where the wire contract is
    // authored (ISS-8233).
    timeoutMs: clampTimerDelayMs(params.timeoutMs, (rejection) => {
      log.warn("toWireCommandFromRelayOperation: malformed relay timeoutMs", {
        operationId,
        ...rejection,
      });
    }),
    lockKey: typeof params.lockKey === "string" ? params.lockKey : undefined,
    requiresApproval:
      typeof params.requiresApproval === "boolean"
        ? params.requiresApproval
        : undefined,
    approvalReason: sanitizeApprovalReason(
      params.approvalReason,
      (rejection) => {
        log.warn(
          "toWireCommandFromRelayOperation: malformed relay approvalReason",
          { operationId, ...rejection }
        );
      }
    ),
    streaming: operation.streaming === true ? true : undefined,
    signature:
      typeof params.signature === "string" ? params.signature : undefined,
    signaturePayload:
      typeof params.signaturePayload === "string"
        ? params.signaturePayload
        : undefined,
    publicKeyFingerprint:
      typeof params.publicKeyFingerprint === "string"
        ? params.publicKeyFingerprint
        : undefined,
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
  "/api/gateway/health-check": "health_check",
  [HEALTH_CHECK_REPAIR_PATH]: HEALTH_CHECK_REPAIR_OPERATION_ID,
  "/api/gateway/version": "health_check",
  "/api/gateway/repos": "repos_config",
  "/api/gateway/directories": "filesystem",
  "/api/gateway/files/search": "filesystem",
  "/api/gateway/git/user": "git_pr",
  "/api/gateway/git/branch-worktree": "git_branch_worktree",
  // ISS-8049: must be exact, and must precede any `git` prefix rule —
  // "github" startsWith "git", so a bare `/api/gateway/git` prefix silently
  // rewrote this command's operationId to `git_action` and every desktop
  // rejected the nudge as unroutable.
  [GITHUB_RESYNC_NUDGE_PATH]: GITHUB_RESYNC_NUDGE_OPERATION_ID,
  "/api/gateway/git": "git_action",
  [BranchViewLocalGatewayPath.List]: BranchViewLocalOperationId.Read,
  [BranchViewLocalGatewayPath.Diff]: BranchViewLocalOperationId.Read,
  [BranchViewLocalGatewayPath.CommitPush]:
    BranchViewLocalOperationId.CommitPush,
  [MEMBER_PACK_INSTALL_PATH]: MEMBER_PACK_INSTALL_OPERATION_ID,
};

/**
 * Prefix-match path → operationId (checked in order, first match wins).
 * Order matters: more-specific prefixes must come before less-specific ones.
 */
export const PREFIX_OPERATION_IDS: [string, string][] = [
  ["/api/gateway/git/pr", "git_pr"],
  // Trailing slash is load-bearing (ISS-8049): a bare `/api/gateway/git`
  // prefix also matches `/api/gateway/github/*`. The bare path itself lives in
  // EXACT_OPERATION_IDS above.
  ["/api/gateway/git/", "git_action"],
];

/**
 * Resolve the semantic operationId that Electron expects for a given
 * desktop API path. This must stay in sync with the Electron
 * desktop app's `resolveOperationId()` in `apps/desktop/src/main/app.ts`.
 */
export function resolveOperationId(pathname: string): string | null {
  if (!isDesktopApiPath(pathname)) {
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

/**
 * Byte ceiling for one desktop-gateway payload, shared by every transport that
 * carries one.
 *
 * The socket lane imports it as `maxHttpBufferSize`. The HTTP lane that
 * carries the SAME payloads (the relay socket-event route) bounds its body at
 * it. Keep the value identical across all of them: a lower bound on one lane
 * refuses a payload its sibling accepts (ISS-7565).
 */
export const DESKTOP_GATEWAY_MAX_PAYLOAD_BYTES = 10 * 1024 * 1024;

/**
 * Deliver one relay operation to a connected desktop socket.
 *
 * The `false` return is the contract `relayEventBus.publishOperation` reads to
 * learn a delivery did not happen. Before ISS-7558 this branch was a bare
 * `return`, so an operation that could not become a wire command was reported
 * to the caller as delivered and then sat Queued until it expired.
 */
export function handleRelayOperationForSocket(
  socket: Socket,
  operation: RelayOperationDispatchRequest,
  targetId: string
): boolean {
  const wireCommand = toWireCommandFromRelayOperation(operation);
  if (!wireCommand) {
    // `warn`, not `error`: the operation is built from caller-supplied command
    // input, so a malformed one is client-driven. At `error` that would be an
    // unbounded, client-driven alert channel. `computeTargetId` is
    // what every other log on this dispatch pipeline groups by; without it
    // these rejections are invisible to a per-target query.
    log.warn("Failed to convert relay operation to wire command", {
      targetId,
      computeTargetId: targetId,
      operationId: operation.operationId,
      socketId: socket.id,
    });
    return false;
  }

  emitCommand(socket, wireCommand);
  return true;
}

/**
 * Bounds the ceiling a desktop declared on hello, before it is persisted.
 *
 * `helloPayloadSchema` bounds this below and not above, and the persisted value
 * is what the dispatch drain later turns into a queue `take` and a `Promise.all`
 * width. Clamping rather than rejecting keeps a modified or older client
 * connected on a value only it can see — a rejected hello would refuse the whole
 * session over a field the client cannot know is out of range.
 *
 * The drain re-applies the same bound (`normalizeMaxInFlightCommands`), so this
 * is the lane that keeps a garbage number out of `compute_targets.capabilities`
 * and away from the readers that do NOT route through that normalizer, such as
 * the `executor_saturation` sampler.
 */
function clampDeclaredMaxInFlightCommands(
  declared: number,
  context: { machineName: string; gatewayId?: string }
): number {
  const floored = Math.floor(declared);
  const applied = Math.min(MAX_IN_FLIGHT_COMMANDS_CEILING, floored);
  if (applied !== floored) {
    log.warn("desktop.hello.maxInFlightCommands.clamped", {
      ...context,
      declared: floored,
      applied,
    });
  }
  return applied;
}
