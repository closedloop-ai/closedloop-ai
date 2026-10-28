import { createHash, randomUUID } from "node:crypto";
import { clampTimerDelayMs } from "@repo/shared-platform/parse-env-ms";
import type {
  DesktopCommandEvent,
  DesktopPresenceEvent,
} from "./cloud-protocol.js";
import { PROTOCOL_VERSION } from "./cloud-protocol.js";

/**
 * Payload coercion and formatting for the cloud socket wire.
 *
 * Split out of `cloud-socket.ts` (ISS-6126) so the service module stays about
 * the socket lifecycle. Everything here is pure and deliberately tolerant: it
 * reads a version-skewed wire payload, so an unknown shape yields null or an
 * empty record rather than throwing.
 */

const AUTH_ERROR_MESSAGE_PATTERN = /\b(unauthorized|forbidden)\b/i;

export function createEnvelope() {
  return {
    protocolVersion: PROTOCOL_VERSION,
    messageId: randomUUID(),
    timestamp: new Date().toISOString(),
  };
}

export function hashAllowedDirectories(directories: string[]): string {
  const canonical = [...directories].sort();
  return createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
}

export function parseDesktopCommand(
  payload: unknown
): DesktopCommandEvent | null {
  const event = asObject(payload);
  const commandId = asNonEmptyString(event.commandId);
  const operationId = asNonEmptyString(event.operationId);
  const method = asMethod(event.method);
  const path = asNonEmptyString(event.path);
  if (
    !(commandId && operationId && method && path?.startsWith("/api/gateway/"))
  ) {
    return null;
  }

  return {
    ...createEnvelope(),
    commandId,
    operationId,
    method,
    path,
    headers: asStringRecord(event.headers) ?? undefined,
    query: asQueryRecord(event.query) ?? undefined,
    body: event.body,
    // Clamped here rather than inside `asFiniteInteger`, which is shared with
    // `event.sequence` on the command-event ack — where 0 is a legitimate value
    // meaning "nothing acked yet" (`lastSequenceAcked` defaults to 0). Flooring
    // that to 1 would mark the first event acked and drop it from replay. A
    // cloud old enough to send an unclamped timeout still gets bounded (ISS-8233).
    timeoutMs: clampTimerDelayMs(event.timeoutMs),
    queuedAt: asNonEmptyString(event.queuedAt) ?? undefined,
    lockKey: asNonEmptyString(event.lockKey) ?? undefined,
    requiresApproval: Boolean(event.requiresApproval),
    approvalReason: asNonEmptyString(event.approvalReason) ?? undefined,
  };
}

export function asObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object") {
    return {};
  }
  return value as Record<string, unknown>;
}

export function asNonEmptyString(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

export function formatObjectKeysForLog(value: Record<string, unknown>): string {
  const keys = Object.keys(value).sort();
  return keys.length > 0 ? keys.join(",") : "none";
}

export function formatPrimitiveForLog(value: unknown): string {
  if (
    value === null ||
    ["boolean", "number", "string", "undefined"].includes(typeof value)
  ) {
    return String(value);
  }
  return typeof value;
}

export function asFiniteInteger(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return null;
  }
  const rounded = Math.trunc(value);
  return rounded >= 0 ? rounded : null;
}

export function asMethod(value: unknown): DesktopCommandEvent["method"] | null {
  if (typeof value !== "string") {
    return null;
  }
  const method = value.toUpperCase();
  if (
    method === "GET" ||
    method === "POST" ||
    method === "PUT" ||
    method === "PATCH" ||
    method === "DELETE"
  ) {
    return method;
  }
  return null;
}

export function asStringRecord(value: unknown): Record<string, string> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  // ISS-8565: null-prototype container so a key literally named `__proto__`
  // becomes an own property instead of hitting the inherited `__proto__`
  // setter, which creates no own key and silently drops the entry.
  const out: Record<string, string> = Object.create(null);
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry === "string") {
      out[key] = entry;
    }
  }
  // Spread restores a normal prototype for downstream consumers (object
  // spread defines rather than assigns, so an own `__proto__` key survives).
  return { ...out };
}

export function asQueryRecord(
  value: unknown
): Record<string, string | string[]> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  // ISS-8565: null-prototype container so a key literally named `__proto__`
  // becomes an own property instead of hitting the inherited `__proto__`
  // setter, which creates no own key and silently drops the entry.
  const out: Record<string, string | string[]> = Object.create(null);
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry === "string") {
      out[key] = entry;
      continue;
    }
    if (
      Array.isArray(entry) &&
      entry.every((item) => typeof item === "string")
    ) {
      out[key] = [...entry];
    }
  }
  // Spread restores a normal prototype for downstream consumers (object
  // spread defines rather than assigns, so an own `__proto__` key survives).
  return { ...out };
}

export function looksLikeAuthError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }
  const data = (error as Error & { data?: unknown }).data;
  // Structured status codes from the server are the most reliable signal
  if (data && typeof data === "object") {
    const statusCode = readStatusCode(data as Record<string, unknown>);
    if (statusCode === 401 || statusCode === 403) {
      return true;
    }
  }
  // Fall back to message matching, but only for explicit auth keywords
  // (excludes "token" which appears in engine.io transport messages)
  if (AUTH_ERROR_MESSAGE_PATTERN.test(error.message)) {
    return true;
  }
  if (typeof data === "string" && AUTH_ERROR_MESSAGE_PATTERN.test(data)) {
    return true;
  }
  return false;
}

/** `statusCode` wins over `status`; neither present reads as 0 (no signal). */
function readStatusCode(record: Record<string, unknown>): number {
  if (typeof record.statusCode === "number") {
    return record.statusCode;
  }
  if (typeof record.status === "number") {
    return record.status;
  }
  return 0;
}

/** The presence error reported while the operator has paused cloud commands. */
export const CLOUD_COMMANDS_PAUSED_ERROR = "cloud commands paused by user";

export type PausedAwarePresenceInput = {
  cloudOnline: boolean;
  paused: boolean;
  gatewayHealthy: boolean;
  activeCommands: number;
  queueDepth: number;
};

/** The presence payload minus the envelope `sendPresence` stamps on. */
export type CloudPresencePayload = Pick<
  DesktopPresenceEvent,
  "state" | "error" | "activeCommands" | "queueDepth"
>;

/**
 * The presence a queue-stats tick or a pause-toggle reports.
 *
 * Both callers report `online` only when all three of the link, the operator's
 * pause switch, and local gateway health agree, and both attach the pause
 * reason. They were the same block copied twice in the composition root, so
 * either could drift into reporting `online` on a sick gateway. The
 * cloud-online transition deliberately reports WITHOUT the gateway-health term
 * — it runs before the first probe — and so does not use this builder.
 */
export function buildPausedAwarePresence(
  input: PausedAwarePresenceInput
): CloudPresencePayload {
  const online = input.cloudOnline && !input.paused && input.gatewayHealthy;
  return {
    state: online ? "online" : "degraded",
    ...(input.paused ? { error: CLOUD_COMMANDS_PAUSED_ERROR } : {}),
    activeCommands: input.activeCommands,
    queueDepth: input.queueDepth,
  };
}
