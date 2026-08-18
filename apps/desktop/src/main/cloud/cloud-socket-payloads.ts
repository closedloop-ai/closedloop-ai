import { createHash, randomUUID } from "node:crypto";
import type { DesktopCommandEvent } from "./cloud-protocol.js";
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
    timeoutMs: asFiniteInteger(event.timeoutMs) ?? undefined,
    queuedAt: asNonEmptyString(event.queuedAt) ?? undefined,
    lockKey: asNonEmptyString(event.lockKey) ?? undefined,
    requiresApproval: Boolean(event.requiresApproval),
    approvalReason: asNonEmptyString(event.approvalReason) ?? undefined,
    ...(asNonEmptyString(event.signature)
      ? { signature: asNonEmptyString(event.signature)! }
      : {}),
    ...(asNonEmptyString(event.signaturePayload)
      ? { signaturePayload: asNonEmptyString(event.signaturePayload)! }
      : {}),
    ...(asNonEmptyString(event.publicKeyFingerprint)
      ? {
          publicKeyFingerprint: asNonEmptyString(event.publicKeyFingerprint)!,
        }
      : {}),
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
  const out: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry === "string") {
      out[key] = entry;
    }
  }
  return out;
}

export function asQueryRecord(
  value: unknown
): Record<string, string | string[]> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const out: Record<string, string | string[]> = {};
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
  return out;
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
