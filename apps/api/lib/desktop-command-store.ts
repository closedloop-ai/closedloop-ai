import { createHash } from "node:crypto";
import type { JsonValue } from "@repo/api/src/types/common";
import type {
  CreateDesktopCommandInput,
  DesktopCommandEvent,
  DesktopCommandEventType,
  DesktopCommandStatus,
  DesktopCommandSummary,
  RelayOperationDispatchRequest,
} from "@repo/api/src/types/compute-target";
import { type Prisma, withDb } from "@repo/database";

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
  createdAt: string;
};

class IdempotencyConflictError extends Error {
  constructor(message = "Idempotency key collision with different payload") {
    super(message);
    this.name = "IdempotencyConflictError";
  }
}

type EventSubscriber = (event: DesktopCommandEvent) => void;

const eventSubscribers = new Map<string, Set<EventSubscriber>>();
const operationIdCache = new Map<string, string>();
const idempotencyCache = new Map<string, IdempotencyEntry>();

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stableStringify(value: unknown): string {
  if (value === null || value === undefined) {
    return "null";
  }
  if (
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(",")}]`;
  }
  if (isRecord(value)) {
    const keys = Object.keys(value).sort();
    return `{${keys
      .map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(String(value));
}

function fingerprintCommand(input: CreateDesktopCommandInput): string {
  return createHash("sha256").update(stableStringify(input)).digest("hex");
}

function isDesktopCommandStatus(value: string): value is DesktopCommandStatus {
  return (
    value === "queued" ||
    value === "accepted" ||
    value === "running" ||
    value === "done" ||
    value === "failed" ||
    value === "cancelled" ||
    value === "expired"
  );
}

function toDesktopCommandStatus(value: string): DesktopCommandStatus {
  return isDesktopCommandStatus(value) ? value : "failed";
}

function isTerminalStatus(status: DesktopCommandStatus): boolean {
  return (
    status === "done" ||
    status === "failed" ||
    status === "cancelled" ||
    status === "expired"
  );
}

function toStoredCommand(row: StoredCommandRow): StoredCommand {
  const requestPayload = isRecord(row.requestPayload)
    ? (row.requestPayload as CreateDesktopCommandInput)
    : ({
        operationId: row.operationId,
        method: "POST",
        path: "/api/engineer",
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
  const path =
    typeof request.path === "string" ? request.path : "/api/engineer";
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
      status: cancelled ? "cancelled" : "done",
      finishedAt: new Date(),
    };
  }

  if (eventType === "error" && isRecord(data) && data.terminal === true) {
    return {
      status: "failed",
      finishedAt: new Date(),
      error: typeof data.error === "string" ? data.error : "Command failed",
    };
  }

  if (eventType === "result" && isRecord(data) && data.terminal === true) {
    const cancelled = data.cancelled === true;
    return {
      status: cancelled ? "cancelled" : "done",
      finishedAt: new Date(),
    };
  }

  if (command.status === "queued" || command.status === "accepted") {
    return {
      status: "running",
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
    throw new IdempotencyConflictError();
  }
  const winnerCommand = toStoredCommand(winner as StoredCommandRow);
  if (winnerCommand.requestFingerprint !== fingerprint) {
    throw new IdempotencyConflictError();
  }
  return { command: winnerCommand, deduped: true };
}

export const desktopCommandStore = {
  async createCommand(
    computeTargetId: string,
    input: CreateDesktopCommandInput
  ): Promise<CreateCommandResult> {
    const idempotencyKey = input.idempotencyKey?.trim() || undefined;
    const fingerprint = fingerprintCommand(input);

    if (idempotencyKey) {
      const cacheKey = `${computeTargetId}:${idempotencyKey}`;
      const cached = idempotencyCache.get(cacheKey);
      if (cached) {
        if (cached.fingerprint !== fingerprint) {
          throw new IdempotencyConflictError();
        }
        const existing = await findCommandById(cached.commandId);
        if (existing) {
          return { command: existing, deduped: true };
        }
      }

      const existing = await withDb((db) =>
        db.desktopCommand.findFirst({
          where: {
            computeTargetId,
            idempotencyKey,
          },
          orderBy: { createdAt: "desc" },
        })
      );

      if (existing) {
        const existingCommand = toStoredCommand(existing as StoredCommandRow);
        if (existingCommand.requestFingerprint !== fingerprint) {
          throw new IdempotencyConflictError();
        }
        idempotencyCache.set(cacheKey, {
          commandId: existingCommand.commandId,
          fingerprint,
        });
        operationIdCache.set(
          existingCommand.operationId,
          existingCommand.commandId
        );
        return { command: existingCommand, deduped: true };
      }
    }

    let created: StoredCommandRow;
    try {
      created = (await withDb((db) =>
        db.desktopCommand.create({
          data: {
            computeTargetId,
            operationId: input.operationId,
            idempotencyKey: idempotencyKey ?? null,
            requestFingerprint: fingerprint,
            requestPayload: input as unknown as Prisma.InputJsonValue,
            status: "queued",
            lastSequenceAcked: 0,
          },
        })
      )) as StoredCommandRow;
    } catch (error) {
      if (idempotencyKey && (error as { code?: string }).code === "P2002") {
        return recoverDuplicateCommand(
          computeTargetId,
          idempotencyKey,
          fingerprint
        );
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

    return { command, deduped: false };
  },

  createFromRelayOperation(
    computeTargetId: string,
    operation: RelayOperationDispatchRequest
  ): Promise<CreateCommandResult> {
    const input = mapRelayPayloadToCommandInput(operation);
    return this.createCommand(computeTargetId, input);
  },

  async acknowledgeCommand(
    commandId: string,
    accepted: boolean,
    reason?: string
  ): Promise<DesktopCommandSummary | null> {
    const command = await findCommandById(commandId);
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
        status: "failed",
        error: reason || "Command rejected",
        finishedAt: now,
      };
    } else if (command.status === "queued") {
      data = { status: "accepted" };
    } else {
      data = {};
    }

    const updated = await withDb((db) =>
      db.desktopCommand.update({
        where: { id: commandId },
        data,
      })
    );

    return toSummary(toStoredCommand(updated as StoredCommandRow));
  },

  async ingestCommandEvent(
    input: IngestCommandEventInput
  ): Promise<IngestCommandEventResult> {
    const result = await withDb.tx(async (tx) => {
      const row = await tx.desktopCommand.findUnique({
        where: { id: input.commandId },
      });
      if (!row) {
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
        return {
          accepted: false,
          reason: "sequence_gap",
          expected,
        } as const;
      }

      const createdEvent = await tx.desktopCommandEvent.create({
        data: {
          commandId: input.commandId,
          sequence,
          eventType: input.eventType,
          eventPayload: input.data as unknown as Prisma.InputJsonValue,
        },
      });

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
          ...(nextState.error !== undefined ? { error: nextState.error } : {}),
        },
      });

      return {
        accepted: true,
        duplicate: false,
        sequence,
        createdAt: createdEvent.createdAt,
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
    commandId: string
  ): Promise<DesktopCommandEvent[] | null> {
    const command = await this.getCommand(computeTargetId, commandId);
    if (!command) {
      return null;
    }

    const events = await withDb((db) =>
      db.desktopCommandEvent.findMany({
        where: { commandId },
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
    options?: { replay?: boolean }
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
        (await this.getCommandEvents(computeTargetId, commandId)) ?? [];
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
    operationId: string
  ): Promise<string | null> {
    const cachedId = operationIdCache.get(operationId);
    if (cachedId) {
      return cachedId;
    }

    const command = await withDb((db) =>
      db.desktopCommand.findFirst({
        where: { operationId },
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

  async markCommandExpired(commandId: string, reason?: string): Promise<void> {
    const command = await findCommandById(commandId);
    if (!command || isTerminalStatus(command.status)) {
      return;
    }

    await withDb((db) =>
      db.desktopCommand.update({
        where: { id: commandId },
        data: {
          status: "expired",
          finishedAt: new Date(),
          error: reason || "Command expired",
        },
      })
    );
  },

  __resetForTests(): void {
    eventSubscribers.clear();
    operationIdCache.clear();
    idempotencyCache.clear();
  },

  IdempotencyConflictError,
};
