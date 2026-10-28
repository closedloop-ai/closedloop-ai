import type { JsonValue } from "@repo/api/src/types/common";
import type {
  CreateDesktopCommandInput,
  DesktopCommandEvent,
  DesktopCommandEventType,
  DesktopCommandSummary,
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
import { ErrorClass } from "@repo/observability/telemetry/schema";
import {
  TelemetryCategory,
  TelemetrySeverity,
} from "@repo/observability/telemetry/telemetry-category";
import { getPrismaErrorCode } from "@/lib/db-utils";
import {
  type EventSubscriber,
  replayBufferedEvents,
  resolveEventReadUpperBound,
} from "@/lib/desktop-command-event-page";
import {
  fingerprintCommand,
  normalizeCommandInput,
  stripTransientCommandFields,
} from "@/lib/desktop-command-fingerprint";
import {
  type CreateCommandResult,
  clearIdempotencyCache,
  findCommandById,
  findCommandByIdScoped,
  IdempotencyConflictError,
  recoverDuplicateCommand,
  rememberIdempotentCommand,
  resolveIdempotentCommand,
} from "@/lib/desktop-command-lookup";
import {
  type DispatchableCommand,
  IN_FLIGHT_DESKTOP_COMMAND_STATUSES,
  STORED_COMMAND_EVENT_SELECT,
  STORED_COMMAND_SELECT,
  type StoredCommandRow,
  TERMINAL_DESKTOP_COMMAND_STATUSES,
  toDispatchableCommand,
  toEventWire,
  toStoredCommand,
  toSummary,
} from "@/lib/desktop-command-mappers";
import { resolveCommandUpdate } from "@/lib/desktop-command-transitions";
import {
  byCreatedAtThenId,
  capQueuedCommandsForReconnect,
  HELLO_QUEUED_COMMAND_LIMIT,
} from "@/lib/desktop-gateway-reconnect";
import type { OrganizationWriteOutcome } from "@/lib/organization-write-receipt";
import {
  type RecordWriteInTransaction,
  writeRecorded,
} from "@/lib/record-write-in-transaction";
import { safeEmit } from "@/lib/telemetry-utils";

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
  | {
      accepted: true;
      duplicate: false;
      sequence: number;
      /**
       * The status this event moved the command to, absent when it changed none.
       * Already returned at runtime; declaring it lets callers release a freed
       * concurrency slot without re-reading the row.
       */
      nextStatus?: DesktopCommandStatus;
    }
  | {
      accepted: false;
      reason: "unknown_command" | "sequence_gap";
      expected?: number;
    };

class ClientCommandIdConflictError extends Error {
  constructor(message = "Command ID already exists") {
    super(message);
    this.name = "ClientCommandIdConflictError";
  }
}

const eventSubscribers = new Map<string, Set<EventSubscriber>>();

function publishEvent(event: DesktopCommandEvent): void {
  const listeners = eventSubscribers.get(event.commandId);
  if (!listeners || listeners.size === 0) {
    return;
  }
  for (const listener of listeners) {
    listener(event);
  }
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

  if (status === DesktopCommandStatus.Done) {
    emitCommandLifecycleEvent(TelemetryCategory.CommandCompleted, trace);
  } else if (status === DesktopCommandStatus.Failed) {
    emitCommandLifecycleEvent(TelemetryCategory.CommandFailed, trace, {
      severity: TelemetrySeverity.Error,
    });
  } else if (status === DesktopCommandStatus.Expired) {
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
      Partial<TelemetryTraceContext>,
    /**
     * Runs on the insert's transaction (ISS-12552); a deduplicated command
     * inserts nothing, so it is not called for one.
     */
    recordWrite?: RecordWriteInTransaction<OrganizationWriteOutcome>
  ): Promise<CreateCommandResult> {
    // Normalize BEFORE the fingerprint and the write: `timeoutMs` is part of
    // `requestPayload` and therefore part of the hash, and the REST route
    // bounds it `.positive()` with no ceiling while the relay mapper clamps.
    const normalized = normalizeCommandInput(input, (rejection) => {
      log.warn("createCommand: timeoutMs out of range, normalized", {
        computeTargetId,
        operationId: input.operationId,
        ...rejection,
      });
    });
    const idempotencyKey = normalized.idempotencyKey?.trim() || undefined;
    const requestPayload = stripTransientCommandFields(normalized);
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
      created = (await writeRecorded(
        recordWrite,
        () =>
          withDb((db) =>
            db.desktopCommand.create({
              data: {
                ...(normalized.commandId ? { id: normalized.commandId } : {}),
                computeTargetId,
                operationId: normalized.operationId,
                idempotencyKey: idempotencyKey ?? null,
                requestFingerprint: fingerprint,
                requestPayload:
                  requestPayload as unknown as Prisma.InputJsonValue,
                status: DesktopCommandStatus.Queued,
                lastSequenceAcked: 0,
              },
            })
          ),
        () => ({ changed: true })
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
    if (idempotencyKey) {
      rememberIdempotentCommand(
        computeTargetId,
        idempotencyKey,
        command.commandId,
        fingerprint
      );
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
    // A late first-ever ack for a row that already went terminal by another
    // path (`markCommandExpired`) writes nothing, so `ackedAt` stays null there
    // even though the target did answer. Harmless for delivery — terminal rows
    // are never requeued, so no retry ever reads them — but it does mean this
    // column is not a complete audit of "did the target ever answer" for
    // terminal rows. Do not repurpose it as one without closing this path.
    if (isTerminalStatus(command.status)) {
      return toSummary(command);
    }

    const now = new Date();
    // ISS-9630: `ackedAt` is stamped on EVERY branch below, including the one
    // that changes nothing else. The column records that the target ANSWERED,
    // which is a different fact from any status it moved to — a rejection is an
    // answer, and so is an ack for a command that already raced ahead to
    // `running`. Writing it only where `status` changes would leave both of
    // those reading back as never-answered, which is exactly the reading a
    // retry policy must not get wrong.
    //
    // The stamp is the QUEUE ATTEMPT being answered, not wall-clock `now`
    // (whitlockk on #7012). `requeueUndeliveredCommands` can advance `queuedAt`
    // between the read above and the write below — the ack that read `running`
    // lands after the reconnect reset — and a `now` taken on this side of that
    // reset is at or after the NEW entry, so `ackedAt >= queuedAt` and the
    // sweep reports work the target had already taken as never answered.
    // Binding to the entry is sound whichever write wins: answering the current
    // delivery leaves `ackedAt == queuedAt` (not earlier), and being requeued
    // underneath leaves `ackedAt < queuedAt` (earlier, which is the truth).
    //
    // `queuedAt` is null only for rows written before ISS-7223 added it, and
    // the crossings read selects on `queuedAt`, so those rows reach no reader
    // of this comparison; `now` is the honest fallback rather than a value
    // pretending to date a queue entry that was never recorded.
    const answeredDeliveryAt = command.queuedAt ?? now;
    let data: {
      status?: string;
      error?: string;
      finishedAt?: Date;
      ackedAt: Date;
    };
    if (!accepted) {
      data = {
        status: DesktopCommandStatus.Failed,
        error: reason || "Command rejected",
        // The terminal instant is when the rejection was PROCESSED, so it stays
        // wall-clock; only the ack stamp dates the delivery it answers.
        finishedAt: now,
        ackedAt: answeredDeliveryAt,
      };
    } else if (command.status === DesktopCommandStatus.Queued) {
      data = {
        status: DesktopCommandStatus.Accepted,
        ackedAt: answeredDeliveryAt,
      };
    } else {
      data = { ackedAt: answeredDeliveryAt };
    }

    // Use conditional update to prevent overwriting a concurrent terminal transition.
    // When accepting a queued command, narrow the guard to "queued" to prevent
    // regressing a command that has already progressed to "running".
    const terminalStatuses = TERMINAL_DESKTOP_COMMAND_STATUSES;
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
          // Last-write-wins is not freshness-safe across instances: two acks
          // for DIFFERENT deliveries of one command can be in flight at once,
          // and the slower of them carries the older entry. Without this clause
          // that straggler overwrites the newer verdict, and a command whose
          // current delivery was answered reads back as answered on an earlier
          // one. The write applies only where it moves the record forward, so a
          // duplicate or superseded ack matches no row and changes nothing —
          // which is also why the status half is guarded by it: an ack for a
          // delivery no newer than the one already answered has no business
          // moving `status` either.
          OR: [{ ackedAt: null }, { ackedAt: { lt: answeredDeliveryAt } }],
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
            select: STORED_COMMAND_SELECT,
          })
        : await tx.desktopCommand.findUnique({
            where: { id: input.commandId },
            select: STORED_COMMAND_SELECT,
          });
      if (!row) {
        log.warn("ingestCommandEvent: unknown command", {
          commandId: input.commandId,
          computeTargetId: input.computeTargetId,
          errorClass: ErrorClass.Execution,
        });
        return { accepted: false, reason: "unknown_command" } as const;
      }

      const command = toStoredCommand(row);
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
          // ISS-9630: an event IS the target answering, so it records the same
          // fact an ack does. This is not redundant with `acknowledgeCommand`:
          // `resolveCommandUpdate`'s queued/accepted arm moves a command to
          // `running` on a streamed event with no accept RPC at all, and a
          // reconnect requeues exactly those in-flight rows. Were this path
          // silent, a command the target had demonstrably taken would read
          // back as never-answered after that requeue — the false negative the
          // column exists to prevent, and the one that would let a retry re-run
          // work that already ran.
          //
          // Bound to the queue attempt this event belongs to, for the reason
          // `acknowledgeCommand` is: a requeue committing between this
          // transaction's read and its write would otherwise leave a wall-clock
          // stamp at or after the NEW entry and erase the earlier-delivery
          // signal. No monotonic guard is needed here — the sequence gate above
          // already refuses anything but `lastSequenceAcked + 1`, so an event
          // from a superseded delivery cannot reach this write.
          ackedAt: command.queuedAt ?? new Date(),
          ...(nextState.status ? { status: nextState.status } : {}),
          ...(nextState.startedAt ? { startedAt: nextState.startedAt } : {}),
          ...(nextState.finishedAt ? { finishedAt: nextState.finishedAt } : {}),
          ...(nextState.error === undefined ? {} : { error: nextState.error }),
        },
        select: { id: true },
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
        select: STORED_COMMAND_SELECT,
      })
    );
    if (!command) {
      return null;
    }
    return toSummary(toStoredCommand(command));
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

    // Bounded by BYTES, not by row count, and it reads forward across as many
    // sizing probes as the budget allows rather than stopping at the first 500
    // rows. Both halves are load-bearing:
    //
    //  - bytes, because nothing caps a single stored payload, so any row cap is
    //    a response bound only by accident (see the constant);
    //  - forward, because the polling consumer gets exactly one call per tick
    //    (the SSE arm's replay poll at 2s), so a fixed 500-row answer puts
    //    delivery at 250 events/sec against a `chunk` per NDJSON line off the
    //    gateway. A chatty run outruns that and the cursor never catches up
    //    for the life of the command.
    //
    // It does not truncate: the caller resumes from the `sequence` of the last
    // event it consumed, so whatever the budget held back arrives on the next
    // poll. Ordering ascending from just after the cursor is what makes that
    // true — do not reorder this read.
    const events = await withDb(async (db) => {
      const throughSequence = await resolveEventReadUpperBound(
        db,
        commandId,
        options?.afterSequence
      );
      if (throughSequence === undefined) {
        return [];
      }
      return db.desktopCommandEvent.findMany({
        where: {
          commandId,
          sequence: {
            ...(options?.afterSequence == null
              ? {}
              : { gt: options.afterSequence }),
            lte: throughSequence,
          },
        },
        orderBy: { sequence: "asc" },
        select: STORED_COMMAND_EVENT_SELECT,
      });
    });

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
      try {
        await replayBufferedEvents({
          readPage: (afterSequence) =>
            this.getCommandEvents(computeTargetId, commandId, {
              afterSequence,
            }),
          afterSequence: options?.afterSequence,
          liveSequences,
          listener,
        });
      } catch (error) {
        // The listener is already registered. Without this the caller never
        // receives the cleanup handle, yet the callback stays in
        // eventSubscribers and every later publish still invokes it.
        unsubscribe();
        throw error;
      }
    }

    return unsubscribe;
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

  /**
   * A hello's pending commands: every in-flight row, plus a bounded queued page.
   *
   * Split by status because only ONE half is safe to cap. An `accepted`/
   * `running` row the handshake does not return is stranded forever — the
   * reconnect requeue derives its id list from this result — so those are read
   * whole. A truncated QUEUED row is still `queued`, so the drain and the next
   * hello can both still reach it; that asymmetry in consequence — not a
   * measurement of which half is deeper — is why the queued half is the capped
   * one.
   *
   * Bounded HERE, not at either caller: both hello lanes issue this read under
   * that same timeout, so a per-caller cap is one a lane can be written
   * without. `HELLO_QUEUED_COMMAND_LIMIT` carries the rest.
   *
   * QUEUED IS READ FIRST, AND THE TWO READS ARE SEQUENTIAL. Splitting one
   * statement into two means two snapshots however they are issued — under READ
   * COMMITTED Postgres takes a fresh one per statement — so a row whose status
   * changes between them lands in both pages or in neither, and the order decides
   * which. Queued-then-in-flight makes the racing transition `queued -> accepted`
   * (what a concurrent `dispatchQueuedCommand` writes) a DUPLICATE, collapsed by
   * id below and harmless on the wire because the desktop executor keys on
   * `commandId` and re-acks. The reverse order makes that same dispatch a MISS:
   * the row is in neither page, so it is neither emitted nor withheld,
   * `requeueUndeliveredCommands` never sees it, and it sits `accepted` on no
   * desktop, counting against `free` until some later reconnect. The miss this
   * order can still produce needs `accepted -> queued`, which only
   * `requeueUndeliveredCommands` writes — and it leaves the row `queued`, which
   * is where the drain looks.
   *
   * `id` breaks the `createdAt` tie. `createdAt` defaults to a transaction
   * timestamp, so a burst shares one value; without a tiebreaker the capped
   * page is a different 256 rows on each hello.
   */
  async listNonTerminalDispatchCommands(
    computeTargetId: string
  ): Promise<DispatchableCommand[]> {
    const { queued, inFlight } = await withDb(async (db) => {
      const queuedPage = await db.desktopCommand.findMany({
        where: { computeTargetId, status: DesktopCommandStatus.Queued },
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
        // One row past the cap, so a bound read is distinguishable from a
        // backlog that happens to be exactly this deep.
        take: HELLO_QUEUED_COMMAND_LIMIT + 1,
        select: STORED_COMMAND_SELECT,
      });
      const inFlightRows = await db.desktopCommand.findMany({
        where: {
          computeTargetId,
          status: { in: IN_FLIGHT_DESKTOP_COMMAND_STATUSES },
        },
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
        select: STORED_COMMAND_SELECT,
      });
      return { queued: queuedPage, inFlight: inFlightRows };
    });

    // In-flight is written second so a row that appeared in both pages keeps its
    // later, truer status.
    const byId = new Map<string, StoredCommandRow>();
    for (const command of capQueuedCommandsForReconnect(
      queued,
      computeTargetId
    )) {
      byId.set(command.id, command);
    }
    for (const command of inFlight) {
      byId.set(command.id, command);
    }

    const pending = [...byId.values()].sort(byCreatedAtThenId);
    return pending.map((row) => toDispatchableCommand(toStoredCommand(row)));
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
          status: { notIn: TERMINAL_DESKTOP_COMMAND_STATUSES },
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
    clearIdempotencyCache();
  },

  IdempotencyConflictError,
  ClientCommandIdConflictError,
};
