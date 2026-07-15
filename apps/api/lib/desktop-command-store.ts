import { createHash } from "node:crypto";
import { stableStringify } from "@closedloop-ai/loops-api/stable-stringify";
import type { JsonValue } from "@repo/api/src/types/common";
import type {
  CreateDesktopCommandInput,
  DesktopCommandEvent,
  DesktopCommandEventType,
  DesktopCommandSummary,
  RelayOperationDispatchRequest,
} from "@repo/api/src/types/compute-target";
import {
  DesktopCommandStatus,
  isTerminalStatus,
} from "@repo/api/src/types/compute-target";
import { type Prisma, type TransactionClient, withDb } from "@repo/database";
import { log } from "@repo/observability/log";
import { emitCommandLifecycleEvent } from "@repo/observability/telemetry/emitter";
import { FilterToken } from "@repo/observability/telemetry/filter-tokens";
import {
  emitProtocolMetric,
  emitQueueMetric,
} from "@repo/observability/telemetry/metrics";
import { ORIGIN } from "@repo/observability/telemetry/origin";
import type { TelemetryTraceContext } from "@repo/observability/telemetry/schema";
import {
  ErrorClass,
  TelemetryCategory,
  TelemetrySeverity,
} from "@repo/observability/telemetry/schema";
import { BoundedCache } from "@/lib/bounded-cache";
import { getPrismaErrorCode } from "@/lib/db-utils";
import { safeEmit } from "@/lib/telemetry-utils";
import { isRecord } from "@/lib/type-guards";

type StoredCommand = {
  commandId: string;
  computeTargetId: string;
  operationId: string;
  status: DesktopCommandStatus;
  requestPayload: CreateDesktopCommandInput;
  error?: string;
  createdAt: Date;
  startedAt?: Date;
  finishedAt?: Date;
  lastSequenceAcked: number;
  idempotencyKey?: string;
  requestFingerprint: string;
};

type StoredCommandRow = {
  id: string;
  computeTargetId: string;
  operationId: string;
  status: string;
  requestPayload: unknown;
  error: string | null;
  createdAt: Date;
  startedAt: Date | null;
  finishedAt: Date | null;
  lastSequenceAcked: number;
  idempotencyKey: string | null;
  requestFingerprint: string;
};

type CreateCommandResult = {
  command: StoredCommand;
  deduped: boolean;
};

type IngestCommandEventInput = {
  commandId: string;
  eventType: DesktopCommandEventType;
  data: JsonValue;
  sequence?: number;
  /** When provided, the command must belong to this target or the event is rejected. */
  computeTargetId?: string;
  /** Optional telemetry trace context for emitting command lifecycle events.
   *  gatewaySessionId and schemaVersion are required for successful emission. */
  context?: Pick<TelemetryTraceContext, "gatewaySessionId" | "schemaVersion"> &
    Partial<TelemetryTraceContext>;
};

type IngestCommandEventResult =
  | { accepted: true; duplicate: true; sequence: number }
  | { accepted: true; duplicate: false; sequence: number }
  | {
      accepted: false;
      reason: "unknown_command" | "sequence_gap";
      expected?: number;
    };

type IdempotencyEntry = {
  commandId: string;
  fingerprint: string;
};

type DispatchableCommand = {
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

class IdempotencyConflictError extends Error {
  constructor(message = "Idempotency key collision with different payload") {
    super(message);
    this.name = "IdempotencyConflictError";
  }
}

class ClientCommandIdConflictError extends Error {
  constructor(message = "Command ID already exists") {
    super(message);
    this.name = "ClientCommandIdConflictError";
  }
}

type EventSubscriber = (event: DesktopCommandEvent) => void;

const eventSubscribers = new Map<string, Set<EventSubscriber>>();

const CACHE_MAX_SIZE = 10_000;
const operationIdCache = new BoundedCache<string, string>(CACHE_MAX_SIZE);
const idempotencyCache = new BoundedCache<string, IdempotencyEntry>(
  CACHE_MAX_SIZE
);

function stripTransientCommandFields(
  input: CreateDesktopCommandInput
): CreateDesktopCommandInput {
  const {
    commandId: _commandId,
    signature: _signature,
    signaturePayload: _signaturePayload,
    publicKeyFingerprint: _publicKeyFingerprint,
    ...persistable
  } = input;
  return persistable;
}

function fingerprintCommand(input: CreateDesktopCommandInput): string {
  return createHash("sha256")
    .update(stableStringify(stripTransientCommandFields(input)))
    .digest("hex");
}

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

function toStoredCommand(row: StoredCommandRow): StoredCommand {
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
    startedAt: row.startedAt ?? undefined,
    finishedAt: row.finishedAt ?? undefined,
    lastSequenceAcked: row.lastSequenceAcked,
    idempotencyKey: row.idempotencyKey ?? undefined,
    requestFingerprint: row.requestFingerprint,
  };
}

function toSummary(command: StoredCommand): DesktopCommandSummary {
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

function toEventWire(
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

function publishEvent(event: DesktopCommandEvent): void {
  const listeners = eventSubscribers.get(event.commandId);
  if (!listeners || listeners.size === 0) {
    return;
  }
  for (const listener of listeners) {
    listener(event);
  }
}

function mapRelayPayloadToCommandInput(
  operation: RelayOperationDispatchRequest
): CreateDesktopCommandInput {
  const params = isRecord(operation.params) ? operation.params : {};
  const request = isRecord(params.request) ? params.request : {};
  const headers = isRecord(request.headers)
    ? Object.fromEntries(
        Object.entries(request.headers).filter(
          (entry): entry is [string, string] => typeof entry[1] === "string"
        )
      )
    : {};
  const method = typeof request.method === "string" ? request.method : "POST";
  const path = typeof request.path === "string" ? request.path : "/api/gateway";
  const timeoutMs =
    typeof params.timeoutMs === "number" ? params.timeoutMs : undefined;
  const lockKey =
    typeof params.lockKey === "string" ? params.lockKey : undefined;
  const requiresApproval =
    typeof params.requiresApproval === "boolean"
      ? params.requiresApproval
      : undefined;
  const approvalReason =
    typeof params.approvalReason === "string"
      ? params.approvalReason
      : undefined;

  return {
    operationId: operation.operationId,
    method: ["GET", "POST", "PUT", "PATCH", "DELETE"].includes(method)
      ? (method as "GET" | "POST" | "PUT" | "PATCH" | "DELETE")
      : "POST",
    path,
    headers,
    body: (request.body as JsonValue | undefined) ?? null,
    timeoutMs,
    lockKey,
    requiresApproval,
    approvalReason,
    streaming: operation.streaming,
  };
}

function toDispatchableCommand(command: StoredCommand): DispatchableCommand {
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

function resolveCommandUpdate(
  command: StoredCommand,
  eventType: DesktopCommandEventType,
  data: JsonValue
): {
  status?: DesktopCommandStatus;
  startedAt?: Date;
  finishedAt?: Date;
  error?: string | null;
} {
  if (isTerminalStatus(command.status)) {
    return {};
  }

  if (eventType === "done") {
    const cancelled = isRecord(data) && data.cancelled === true;
    return {
      status: cancelled
        ? DesktopCommandStatus.Cancelled
        : DesktopCommandStatus.Done,
      finishedAt: new Date(),
    };
  }

  if (eventType === "error" && isRecord(data) && data.terminal === true) {
    return {
      status: DesktopCommandStatus.Failed,
      finishedAt: new Date(),
      error: typeof data.error === "string" ? data.error : "Command failed",
    };
  }

  if (eventType === "result" && isRecord(data) && data.terminal === true) {
    const cancelled = data.cancelled === true;
    return {
      status: cancelled
        ? DesktopCommandStatus.Cancelled
        : DesktopCommandStatus.Done,
      finishedAt: new Date(),
    };
  }

  if (
    command.status === DesktopCommandStatus.Queued ||
    command.status === DesktopCommandStatus.Accepted
  ) {
    return {
      status: DesktopCommandStatus.Running,
      startedAt: command.startedAt ?? new Date(),
    };
  }

  return {};
}

async function findCommandById(
  commandId: string
): Promise<StoredCommand | null> {
  const command = await withDb((db) =>
    db.desktopCommand.findUnique({
      where: { id: commandId },
    })
  );
  if (!command) {
    return null;
  }
  return toStoredCommand(command as StoredCommandRow);
}

async function findCommandByIdScoped(
  commandId: string,
  computeTargetId?: string
): Promise<StoredCommand | null> {
  if (!computeTargetId) {
    return findCommandById(commandId);
  }
  const row = await withDb((db) =>
    db.desktopCommand.findFirst({
      where: { id: commandId, computeTargetId },
    })
  );
  return row ? toStoredCommand(row as StoredCommandRow) : null;
}

async function recoverDuplicateCommand(
  computeTargetId: string,
  idempotencyKey: string,
  fingerprint: string
): Promise<CreateCommandResult> {
  const winner = await withDb((db) =>
    db.desktopCommand.findFirst({
      where: { computeTargetId, idempotencyKey },
      orderBy: { createdAt: "desc" },
    })
  );
  if (!winner) {
    log.warn("recoverDuplicateCommand: no winner found for idempotency key", {
      computeTargetId,
      idempotencyKey,
      errorClass: ErrorClass.Protocol,
    });
    throw new IdempotencyConflictError();
  }
  const winnerCommand = toStoredCommand(winner as StoredCommandRow);
  if (winnerCommand.requestFingerprint !== fingerprint) {
    log.warn(
      "recoverDuplicateCommand: fingerprint mismatch on idempotency key",
      {
        computeTargetId,
        idempotencyKey,
        errorClass: ErrorClass.Protocol,
      }
    );
    throw new IdempotencyConflictError();
  }
  return { command: winnerCommand, deduped: true };
}

async function createEventRow(
  tx: TransactionClient,
  input: IngestCommandEventInput,
  sequence: number
): Promise<{ createdAt: Date } | "duplicate"> {
  try {
    return await tx.desktopCommandEvent.create({
      data: {
        commandId: input.commandId,
        sequence,
        eventType: input.eventType,
        eventPayload: input.data as unknown as Prisma.InputJsonValue,
      },
    });
  } catch (error) {
    if (getPrismaErrorCode(error) === "P2002") {
      return "duplicate";
    }
    throw error;
  }
}

async function resolveIdempotentCommand(
  computeTargetId: string,
  idempotencyKey: string,
  fingerprint: string
): Promise<CreateCommandResult | null> {
  const cacheKey = `${computeTargetId}:${idempotencyKey}`;
  const cached = idempotencyCache.get(cacheKey);
  if (cached) {
    if (cached.fingerprint !== fingerprint) {
      log.warn(
        "resolveIdempotentCommand: cache fingerprint mismatch on idempotency key",
        {
          computeTargetId,
          idempotencyKey,
          errorClass: ErrorClass.Protocol,
        }
      );
      throw new IdempotencyConflictError();
    }
    const existing = await findCommandById(cached.commandId);
    if (existing) {
      return { command: existing, deduped: true };
    }
  }

  const existing = await withDb((db) =>
    db.desktopCommand.findFirst({
      where: { computeTargetId, idempotencyKey },
      orderBy: { createdAt: "desc" },
    })
  );

  if (!existing) {
    return null;
  }

  const existingCommand = toStoredCommand(existing as StoredCommandRow);
  if (existingCommand.requestFingerprint !== fingerprint) {
    log.warn(
      "resolveIdempotentCommand: db fingerprint mismatch on idempotency key",
      {
        computeTargetId,
        idempotencyKey,
        errorClass: ErrorClass.Protocol,
      }
    );
    throw new IdempotencyConflictError();
  }
  idempotencyCache.set(cacheKey, {
    commandId: existingCommand.commandId,
    fingerprint,
  });
  operationIdCache.set(existingCommand.operationId, existingCommand.commandId);
  return { command: existingCommand, deduped: true };
}

function emitCommandLifecycleEventForStatus(
  status: DesktopCommandStatus,
  commandId: string,
  operationId: string,
  computeTargetId: string,
  context: Pick<TelemetryTraceContext, "gatewaySessionId" | "schemaVersion"> &
    Partial<TelemetryTraceContext>
): void {
  const trace: Partial<TelemetryTraceContext> = {
    ...context,
    commandId,
    operationId,
    computeTargetId,
  };

  if (status === "done") {
    emitCommandLifecycleEvent(TelemetryCategory.CommandCompleted, trace);
  } else if (status === "failed") {
    emitCommandLifecycleEvent(TelemetryCategory.CommandFailed, trace, {
      severity: TelemetrySeverity.Error,
    });
  } else if (status === "expired") {
    emitCommandLifecycleEvent(TelemetryCategory.CommandTimedOut, trace, {
      severity: TelemetrySeverity.Warn,
    });
  }
}

function emitSequenceGapMetric(
  gapDelta: number,
  computeTargetId?: string
): void {
  safeEmit(() =>
    emitProtocolMetric({
      metric: "event_ordering_gaps",
      origin: ORIGIN,
      value: gapDelta,
      ...(computeTargetId ? { computeTargetId } : {}),
    })
  );
}

export const desktopCommandStore = {
  async createCommand(
    computeTargetId: string,
    input: CreateDesktopCommandInput,
    context?: Pick<
      TelemetryTraceContext,
      "gatewaySessionId" | "schemaVersion"
    > &
      Partial<TelemetryTraceContext>
  ): Promise<CreateCommandResult> {
    const idempotencyKey = input.idempotencyKey?.trim() || undefined;
    const requestPayload = stripTransientCommandFields(input);
    // Fingerprint with the trimmed key so " key " and "key" produce the
    // same hash — prevents false IdempotencyConflictError on retry.
    const fingerprint = fingerprintCommand({
      ...requestPayload,
      idempotencyKey,
    });

    if (idempotencyKey) {
      const deduped = await resolveIdempotentCommand(
        computeTargetId,
        idempotencyKey,
        fingerprint
      );
      if (deduped) {
        return deduped;
      }
    }

    let created: StoredCommandRow;
    try {
      created = (await withDb((db) =>
        db.desktopCommand.create({
          data: {
            ...(input.commandId ? { id: input.commandId } : {}),
            computeTargetId,
            operationId: input.operationId,
            idempotencyKey: idempotencyKey ?? null,
            requestFingerprint: fingerprint,
            requestPayload: requestPayload as unknown as Prisma.InputJsonValue,
            status: DesktopCommandStatus.Queued,
            lastSequenceAcked: 0,
          },
        })
      )) as StoredCommandRow;
    } catch (error) {
      if (idempotencyKey && getPrismaErrorCode(error) === "P2002") {
        return recoverDuplicateCommand(
          computeTargetId,
          idempotencyKey,
          fingerprint
        );
      }
      if (input.commandId && getPrismaErrorCode(error) === "P2002") {
        throw new ClientCommandIdConflictError();
      }
      throw error;
    }

    const command = toStoredCommand(created);
    operationIdCache.set(command.operationId, command.commandId);
    if (idempotencyKey) {
      idempotencyCache.set(`${computeTargetId}:${idempotencyKey}`, {
        commandId: command.commandId,
        fingerprint,
      });
    }

    if (context) {
      emitCommandLifecycleEvent(TelemetryCategory.CommandQueued, {
        commandId: command.commandId,
        operationId: command.operationId,
        computeTargetId,
        ...context,
      });
    }

    return { command, deduped: false };
  },

  createFromRelayOperation(
    computeTargetId: string,
    operation: RelayOperationDispatchRequest,
    context?: Pick<
      TelemetryTraceContext,
      "gatewaySessionId" | "schemaVersion"
    > &
      Partial<TelemetryTraceContext>
  ): Promise<CreateCommandResult> {
    const input = mapRelayPayloadToCommandInput(operation);
    return this.createCommand(computeTargetId, input, context);
  },

  /**
   * Acknowledges a queued command as either accepted or rejected.
   *
   * @param context - Optional telemetry trace context. Note: `gatewaySessionId`
   *   being set does not guarantee a registered gateway session —
   *   `buildTelemetryTraceContext` defaults it to the zero-UUID sentinel
   *   "00000000-0000-0000-0000-000000000000" when no session is registered.
   */
  async acknowledgeCommand(
    commandId: string,
    accepted: boolean,
    reason?: string,
    computeTargetId?: string,
    context?: Pick<
      TelemetryTraceContext,
      "gatewaySessionId" | "schemaVersion"
    > &
      Partial<TelemetryTraceContext>
  ): Promise<DesktopCommandSummary | null> {
    const command = await findCommandByIdScoped(commandId, computeTargetId);
    if (!command) {
      return null;
    }
    if (isTerminalStatus(command.status)) {
      return toSummary(command);
    }

    const now = new Date();
    let data:
      | {
          status?: string;
          error?: string;
          finishedAt?: Date;
        }
      | Record<string, never>;
    if (!accepted) {
      data = {
        status: DesktopCommandStatus.Failed,
        error: reason || "Command rejected",
        finishedAt: now,
      };
    } else if (command.status === DesktopCommandStatus.Queued) {
      data = { status: DesktopCommandStatus.Accepted };
    } else {
      data = {};
    }

    // Use conditional update to prevent overwriting a concurrent terminal transition.
    // When accepting a queued command, narrow the guard to "queued" to prevent
    // regressing a command that has already progressed to "running".
    const terminalStatuses = [
      DesktopCommandStatus.Done,
      DesktopCommandStatus.Failed,
      DesktopCommandStatus.Cancelled,
      DesktopCommandStatus.Expired,
    ];
    const statusGuard:
      | DesktopCommandStatus
      | { notIn: DesktopCommandStatus[] } =
      accepted && command.status === DesktopCommandStatus.Queued
        ? DesktopCommandStatus.Queued
        : { notIn: terminalStatuses };

    const { count } = await withDb((db) =>
      db.desktopCommand.updateMany({
        where: {
          id: commandId,
          ...(computeTargetId ? { computeTargetId } : {}),
          status: statusGuard,
        },
        data,
      })
    );

    const ackLatencyMs = Date.now() - command.createdAt.getTime();

    // Emit CommandAcknowledged independently of the DB state transition.
    // The ack and desktop.command.event travel independent paths, so a fast
    // command can flip to `running` before this block runs — in that case
    // `toStatus` would be undefined (or count === 0 from the queued→running
    // race) and the ack-latency signal would be lost. Emitting per-call gives
    // at-least-once semantics; downstream dedupes on (commandId, timestamp).
    if (context) {
      try {
        emitCommandLifecycleEvent(
          TelemetryCategory.CommandAcknowledged,
          {
            ...context,
            commandId,
            operationId: command.operationId,
            computeTargetId: computeTargetId ?? command.computeTargetId,
          },
          { diagnostics: { ackLatencyMs } }
        );
      } catch (emitError) {
        log.warn("CommandAcknowledged lifecycle emit failed", {
          commandId,
          computeTargetId: computeTargetId ?? command.computeTargetId,
          error: emitError,
        });
      }
    }

    // If no rows updated, re-fetch to return current state
    if (count === 0) {
      const current = await findCommandByIdScoped(commandId, computeTargetId);
      return current ? toSummary(current) : null;
    }

    const toStatus = (data as { status?: string }).status;
    if (toStatus) {
      emitQueueMetric({
        metric: "command_state_transition",
        origin: ORIGIN,
        fromStatus: command.status,
        toStatus,
        commandId,
        computeTargetId: computeTargetId ?? command.computeTargetId,
      });
    }

    const updated = await findCommandByIdScoped(commandId, computeTargetId);
    return updated ? toSummary(updated) : null;
  },

  async ingestCommandEvent(
    input: IngestCommandEventInput
  ): Promise<IngestCommandEventResult> {
    const result = await withDb.tx(async (tx) => {
      const row = input.computeTargetId
        ? await tx.desktopCommand.findFirst({
            where: {
              id: input.commandId,
              computeTargetId: input.computeTargetId,
            },
          })
        : await tx.desktopCommand.findUnique({
            where: { id: input.commandId },
          });
      if (!row) {
        log.warn("ingestCommandEvent: unknown command", {
          commandId: input.commandId,
          computeTargetId: input.computeTargetId,
          errorClass: ErrorClass.Execution,
        });
        return { accepted: false, reason: "unknown_command" } as const;
      }

      const command = toStoredCommand(row as StoredCommandRow);
      const expected = command.lastSequenceAcked + 1;
      const sequence = input.sequence ?? expected;

      if (sequence < expected) {
        return {
          accepted: true,
          duplicate: true,
          sequence,
        } as const;
      }
      if (sequence > expected) {
        log.warn("ingestCommandEvent: sequence gap detected", {
          commandId: input.commandId,
          sequence,
          expected,
          errorClass: ErrorClass.Protocol,
        });
        emitSequenceGapMetric(sequence - expected, input.computeTargetId);
        return {
          accepted: false,
          reason: "sequence_gap",
          expected,
        } as const;
      }

      const createResult = await createEventRow(tx, input, sequence);
      if (createResult === "duplicate") {
        return { accepted: true, duplicate: true, sequence } as const;
      }
      const createdEvent = createResult;

      const nextState = resolveCommandUpdate(
        command,
        input.eventType,
        input.data
      );
      await tx.desktopCommand.update({
        where: { id: input.commandId },
        data: {
          lastSequenceAcked: sequence,
          ...(nextState.status ? { status: nextState.status } : {}),
          ...(nextState.startedAt ? { startedAt: nextState.startedAt } : {}),
          ...(nextState.finishedAt ? { finishedAt: nextState.finishedAt } : {}),
          ...(nextState.error === undefined ? {} : { error: nextState.error }),
        },
      });

      return {
        accepted: true,
        duplicate: false,
        sequence,
        createdAt: createdEvent.createdAt,
        nextStatus: nextState.status,
        prevStatus: command.status,
        operationId: command.operationId,
        computeTargetId: command.computeTargetId,
      } as const;
    });

    if (result.accepted && !result.duplicate) {
      publishEvent(
        toEventWire(
          input.commandId,
          result.sequence,
          input.eventType,
          input.data,
          result.createdAt
        )
      );

      if (result.nextStatus) {
        emitQueueMetric({
          metric: "command_state_transition",
          origin: ORIGIN,
          fromStatus: result.prevStatus,
          toStatus: result.nextStatus,
          commandId: input.commandId,
          computeTargetId: result.computeTargetId,
        });
      }

      if (result.nextStatus && input.context) {
        emitCommandLifecycleEventForStatus(
          result.nextStatus,
          input.commandId,
          result.operationId,
          result.computeTargetId,
          input.context
        );
      }
    }

    return result;
  },

  async getCommand(
    computeTargetId: string,
    commandId: string
  ): Promise<DesktopCommandSummary | null> {
    const command = await withDb((db) =>
      db.desktopCommand.findFirst({
        where: {
          id: commandId,
          computeTargetId,
        },
      })
    );
    if (!command) {
      return null;
    }
    return toSummary(toStoredCommand(command as StoredCommandRow));
  },

  async getCommandByOperationId(
    operationId: string
  ): Promise<DesktopCommandSummary | null> {
    const cachedId = operationIdCache.get(operationId);
    if (cachedId) {
      const cached = await findCommandById(cachedId);
      if (cached) {
        return toSummary(cached);
      }
    }

    const command = await withDb((db) =>
      db.desktopCommand.findFirst({
        where: { operationId },
        orderBy: { createdAt: "desc" },
      })
    );
    if (!command) {
      return null;
    }
    const stored = toStoredCommand(command as StoredCommandRow);
    operationIdCache.set(stored.operationId, stored.commandId);
    return toSummary(stored);
  },

  async getCommandById(
    commandId: string
  ): Promise<DesktopCommandSummary | null> {
    const command = await findCommandById(commandId);
    return command ? toSummary(command) : null;
  },

  async getCommandEvents(
    computeTargetId: string,
    commandId: string,
    options?: { afterSequence?: number }
  ): Promise<DesktopCommandEvent[] | null> {
    const command = await this.getCommand(computeTargetId, commandId);
    if (!command) {
      return null;
    }

    const events = await withDb((db) =>
      db.desktopCommandEvent.findMany({
        where: {
          commandId,
          ...(options?.afterSequence == null
            ? {}
            : { sequence: { gt: options.afterSequence } }),
        },
        orderBy: { sequence: "asc" },
      })
    );

    return events.map((event) =>
      toEventWire(
        event.commandId,
        event.sequence,
        event.eventType as DesktopCommandEventType,
        event.eventPayload as JsonValue,
        event.createdAt
      )
    );
  },

  async subscribeCommandEvents(
    computeTargetId: string,
    commandId: string,
    listener: EventSubscriber,
    options?: { replay?: boolean; afterSequence?: number }
  ): Promise<(() => void) | null> {
    const command = await this.getCommand(computeTargetId, commandId);
    if (!command) {
      return null;
    }

    // Register the listener BEFORE replaying from DB so no events
    // published between the DB query and registration are missed.
    const liveSequences = new Set<number>();
    const replayNeeded = options?.replay !== false;
    const wrappedListener: EventSubscriber = replayNeeded
      ? (event) => {
          if (typeof event.sequence === "number") {
            liveSequences.add(event.sequence);
          }
          listener(event);
        }
      : listener;

    const listeners =
      eventSubscribers.get(commandId) ?? new Set<EventSubscriber>();
    listeners.add(wrappedListener);
    eventSubscribers.set(commandId, listeners);

    const unsubscribe = () => {
      const next = eventSubscribers.get(commandId);
      if (!next) {
        return;
      }
      next.delete(wrappedListener);
      if (next.size === 0) {
        eventSubscribers.delete(commandId);
      }
    };

    if (replayNeeded) {
      const replay =
        (await this.getCommandEvents(computeTargetId, commandId, {
          afterSequence: options?.afterSequence,
        })) ?? [];
      for (const event of replay) {
        if (
          typeof event.sequence === "number" &&
          liveSequences.has(event.sequence)
        ) {
          continue;
        }
        listener(event);
      }
    }

    return unsubscribe;
  },

  async findCommandIdByOperationId(
    operationId: string,
    computeTargetId?: string
  ): Promise<string | null> {
    const cachedId = operationIdCache.get(operationId);
    if (cachedId) {
      return cachedId;
    }

    const where: { operationId: string; computeTargetId?: string } = {
      operationId,
    };
    if (computeTargetId) {
      where.computeTargetId = computeTargetId;
    }

    const command = await withDb((db) =>
      db.desktopCommand.findFirst({
        where,
        select: { id: true },
        orderBy: { createdAt: "desc" },
      })
    );
    if (!command) {
      return null;
    }

    operationIdCache.set(operationId, command.id);
    return command.id;
  },

  countCommandsForTarget(
    computeTargetId: string,
    statuses: DesktopCommandStatus | DesktopCommandStatus[]
  ): Promise<number> {
    return withDb((db) =>
      db.desktopCommand.count({
        where: {
          computeTargetId,
          status: Array.isArray(statuses) ? { in: statuses } : statuses,
        },
      })
    );
  },

  async listNonTerminalDispatchCommands(
    computeTargetId: string
  ): Promise<DispatchableCommand[]> {
    const commands = await withDb((db) =>
      db.desktopCommand.findMany({
        where: {
          computeTargetId,
          status: {
            notIn: ["done", "failed", "cancelled", "expired"],
          },
        },
        orderBy: { createdAt: "asc" },
      })
    );

    return commands.map((row) => toDispatchableCommand(toStoredCommand(row)));
  },

  async markCommandExpired(
    commandId: string,
    reason?: string,
    context?: Partial<TelemetryTraceContext>
  ): Promise<void> {
    const { count } = await withDb((db) =>
      db.desktopCommand.updateMany({
        where: {
          id: commandId,
          status: {
            notIn: [
              DesktopCommandStatus.Done,
              DesktopCommandStatus.Failed,
              DesktopCommandStatus.Cancelled,
              DesktopCommandStatus.Expired,
            ],
          },
        },
        data: {
          status: DesktopCommandStatus.Expired,
          finishedAt: new Date(),
          error: reason || "Command expired",
        },
      })
    );

    if (count > 0) {
      emitQueueMetric({
        metric: "command_state_transition",
        origin: ORIGIN,
        toStatus: DesktopCommandStatus.Expired,
        commandId,
      });

      safeEmit(() =>
        emitQueueMetric({
          metric: "dropped_expired_work_items",
          origin: ORIGIN,
          count,
          filterToken: FilterToken.WorkItemDroppedExpired,
          ...(reason ? { reason } : {}),
          ...(context?.computeTargetId
            ? { computeTargetId: context.computeTargetId }
            : {}),
        })
      );

      if (context) {
        emitCommandLifecycleEvent(
          TelemetryCategory.CommandTimedOut,
          {
            commandId,
            ...context,
          },
          {
            severity: TelemetrySeverity.Warn,
            message: reason,
          }
        );
      }
    }
  },

  __resetForTests(): void {
    eventSubscribers.clear();
    operationIdCache.clear();
    idempotencyCache.clear();
  },

  IdempotencyConflictError,
  ClientCommandIdConflictError,
};
