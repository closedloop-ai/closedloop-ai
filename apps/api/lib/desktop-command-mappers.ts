import type { JsonValue } from "@repo/api/src/types/common";
import type {
  CreateDesktopCommandInput,
  DesktopCommandEvent,
  DesktopCommandEventType,
  DesktopCommandSummary,
} from "@repo/api/src/types/compute-target";
import { DesktopCommandStatus } from "@repo/api/src/types/compute-target";
import { isRecord } from "@/lib/type-guards";

/**
 * Pure `desktop_commands` record ↔ wire mapping for `desktop-command-store`.
 *
 * Extracted so the store module stays an orchestration/persistence surface and
 * the projection rules — which columns a stored command is made of, and how it
 * becomes a summary, an SSE event, or a dispatchable operation — live in one
 * place next to the `select` that produces them.
 */

export type StoredCommand = {
  commandId: string;
  computeTargetId: string;
  operationId: string;
  status: DesktopCommandStatus;
  requestPayload: CreateDesktopCommandInput;
  error?: string;
  createdAt: Date;
  /**
   * When the delivery now outstanding was queued, or `undefined` for a row
   * written before ISS-7223 added the column.
   *
   * Read by `acknowledgeCommand`, which stamps `ackedAt` with the queue attempt
   * it is answering rather than with wall-clock now — see the comment there for
   * why the difference decides the reconnect race.
   */
  queuedAt?: Date;
  startedAt?: Date;
  finishedAt?: Date;
  lastSequenceAcked: number;
  idempotencyKey?: string;
  requestFingerprint: string;
};

export type StoredCommandRow = {
  id: string;
  computeTargetId: string;
  operationId: string;
  status: string;
  requestPayload: unknown;
  error: string | null;
  createdAt: Date;
  queuedAt: Date | null;
  startedAt: Date | null;
  finishedAt: Date | null;
  lastSequenceAcked: number;
  idempotencyKey: string | null;
  requestFingerprint: string;
};

export type DispatchableCommand = {
  commandId: string;
  computeTargetId: string;
  operationId: string;
  status: DesktopCommandStatus;
  lastSequenceAcked: number;
  method: CreateDesktopCommandInput["method"];
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
};

function isDesktopCommandStatus(value: string): value is DesktopCommandStatus {
  return (
    value === DesktopCommandStatus.Queued ||
    value === DesktopCommandStatus.Accepted ||
    value === DesktopCommandStatus.Running ||
    value === DesktopCommandStatus.Done ||
    value === DesktopCommandStatus.Failed ||
    value === DesktopCommandStatus.Cancelled ||
    value === DesktopCommandStatus.Expired
  );
}

function toDesktopCommandStatus(value: string): DesktopCommandStatus {
  return isDesktopCommandStatus(value) ? value : DesktopCommandStatus.Failed;
}

export function toStoredCommand(row: StoredCommandRow): StoredCommand {
  const requestPayload = isRecord(row.requestPayload)
    ? (row.requestPayload as CreateDesktopCommandInput)
    : ({
        operationId: row.operationId,
        method: "POST",
        path: "/api/gateway",
      } as CreateDesktopCommandInput);

  return {
    commandId: row.id,
    computeTargetId: row.computeTargetId,
    operationId: row.operationId,
    status: toDesktopCommandStatus(row.status),
    requestPayload,
    error: row.error ?? undefined,
    createdAt: row.createdAt,
    queuedAt: row.queuedAt ?? undefined,
    startedAt: row.startedAt ?? undefined,
    finishedAt: row.finishedAt ?? undefined,
    lastSequenceAcked: row.lastSequenceAcked,
    idempotencyKey: row.idempotencyKey ?? undefined,
    requestFingerprint: row.requestFingerprint,
  };
}

export function toSummary(command: StoredCommand): DesktopCommandSummary {
  return {
    commandId: command.commandId,
    computeTargetId: command.computeTargetId,
    operationId: command.operationId,
    status: command.status,
    error: command.error,
    createdAt: command.createdAt.toISOString(),
    startedAt: command.startedAt?.toISOString(),
    finishedAt: command.finishedAt?.toISOString(),
    lastSequenceAcked: command.lastSequenceAcked,
    idempotencyKey: command.idempotencyKey,
  };
}

export function toEventWire(
  commandId: string,
  sequence: number,
  eventType: DesktopCommandEventType,
  data: JsonValue,
  createdAt?: Date
): DesktopCommandEvent {
  return {
    commandId,
    sequence,
    eventType,
    data,
    createdAt: (createdAt ?? new Date()).toISOString(),
  };
}

export function toDispatchableCommand(
  command: StoredCommand
): DispatchableCommand {
  return {
    commandId: command.commandId,
    computeTargetId: command.computeTargetId,
    operationId: command.operationId,
    status: command.status,
    lastSequenceAcked: command.lastSequenceAcked,
    method: command.requestPayload.method,
    path: command.requestPayload.path,
    headers: command.requestPayload.headers,
    query: command.requestPayload.query,
    body: command.requestPayload.body,
    timeoutMs: command.requestPayload.timeoutMs,
    lockKey: command.requestPayload.lockKey,
    requiresApproval: command.requestPayload.requiresApproval,
    approvalReason: command.requestPayload.approvalReason,
    streaming: command.requestPayload.streaming,
    createdAt: command.createdAt.toISOString(),
  };
}

/**
 * The RETURNING list every `desktop_commands` read in the store uses.
 *
 * It is exactly `keyof StoredCommandRow` — enforced by the `satisfies` below,
 * so a field added to the row type fails `tsc` here instead of arriving
 * `undefined` in `toStoredCommand`. `queued_timeout_ms` / `running_timeout_ms`
 * are deliberately absent: nothing in `apps/api` reads them, and no wire shape
 * derived from these rows (`DesktopCommandSummary`, `DispatchableCommand`, the
 * SSE event) has ever carried them.
 */
export const STORED_COMMAND_SELECT = {
  id: true,
  computeTargetId: true,
  operationId: true,
  status: true,
  requestPayload: true,
  error: true,
  createdAt: true,
  queuedAt: true,
  startedAt: true,
  finishedAt: true,
  lastSequenceAcked: true,
  idempotencyKey: true,
  requestFingerprint: true,
} as const satisfies Record<keyof StoredCommandRow, true>;

export type StoredCommandEventRow = {
  commandId: string;
  sequence: number;
  eventType: string;
  eventPayload: unknown;
  createdAt: Date;
};

/**
 * The RETURNING list `getCommandEvents` uses.
 *
 * `desktop_command_events` currently has no column `toEventWire` does not read,
 * so this is a CONTRACT PIN rather than a column reduction: it is the
 * `satisfies` that carries the value, because a column added to the table would
 * otherwise widen an SSE-adjacent read silently, and `toEventWire`'s two
 * field-level casts (`eventType`, `eventPayload`) mean the compiler cannot be
 * relied on to notice a row shape that drifted the other way.
 */
export const STORED_COMMAND_EVENT_SELECT = {
  commandId: true,
  sequence: true,
  eventType: true,
  eventPayload: true,
  createdAt: true,
} as const satisfies Record<keyof StoredCommandEventRow, true>;

/**
 * Whether a command can still change state. Written as an exhaustive record so a
 * new `DesktopCommandStatus` fails `tsc` here and has to be classified; the two
 * exports below are DERIVED from it rather than hand-listed, because a side
 * inventory typed `DesktopCommandStatus[]` still compiles when a member is added
 * and would silently enrol the newcomer as non-terminal.
 */
const COMMAND_STATUS_IS_TERMINAL: Record<DesktopCommandStatus, boolean> = {
  [DesktopCommandStatus.Queued]: false,
  [DesktopCommandStatus.Accepted]: false,
  [DesktopCommandStatus.Running]: false,
  [DesktopCommandStatus.Done]: true,
  [DesktopCommandStatus.Failed]: true,
  [DesktopCommandStatus.Cancelled]: true,
  [DesktopCommandStatus.Expired]: true,
};

export function isTerminalDesktopCommandStatus(
  status: DesktopCommandStatus
): boolean {
  return COMMAND_STATUS_IS_TERMINAL[status];
}

export const TERMINAL_DESKTOP_COMMAND_STATUSES = Object.values(
  DesktopCommandStatus
).filter(isTerminalDesktopCommandStatus);

/**
 * The statuses the cloud considers in flight on a desktop: non-terminal, minus
 * `queued`.
 *
 * Derived from the same exhaustive record as `TERMINAL_DESKTOP_COMMAND_STATUSES`
 * rather than hand-listed, for the reason stated above it: a literal
 * `[Accepted, Running]` pair still compiles when a fourth non-terminal status is
 * added, so the newcomer would silently drop out of every in-flight read, count,
 * and requeue while nothing failed `tsc`.
 */
export const IN_FLIGHT_DESKTOP_COMMAND_STATUSES = Object.values(
  DesktopCommandStatus
).filter(
  (status) =>
    !isTerminalDesktopCommandStatus(status) &&
    status !== DesktopCommandStatus.Queued
);
