import type { CreateDesktopCommandInput } from "@repo/api/src/types/compute-target";
import { DesktopCommandStatus } from "@repo/api/src/types/compute-target";
import { log } from "@repo/observability/log";
import { emitCommandLifecycleEvent } from "@repo/observability/telemetry/emitter";
import { ErrorClass } from "@repo/observability/telemetry/schema";
import { TelemetryCategory } from "@repo/observability/telemetry/telemetry-category";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { rememberIdempotentCommand } from "@/lib/desktop-command-lookup";
import {
  STORED_COMMAND_SELECT,
  type StoredCommandRow,
} from "@/lib/desktop-command-mappers";
import { resolveCommandUpdate } from "@/lib/desktop-command-transitions";

/**
 * ISS-10513 (lane i): branch coverage for `desktop-command-store.ts` that the
 * sibling `desktop-command-store.test.ts` (ISS-7561/ISS-8233) does not reach —
 * idempotency-cache reuse, telemetry-context branches on `createCommand` and
 * `acknowledgeCommand`, the `emitCommandLifecycleEventForStatus` dispatch table,
 * and the read path on `getCommandById`.
 *
 * `resolveCommandUpdate` is mocked here (unlike the sibling file) so the
 * per-status branches of `emitCommandLifecycleEventForStatus` can be driven
 * directly. The "expired" status is deliberately NOT exercised this way:
 * `resolveCommandUpdate` never actually returns it from `ingestCommandEvent`
 * in production, and the real producer of that status, `markCommandExpired`,
 * reaches `emitCommandLifecycleEvent` directly rather than through this
 * dispatch table — so pinning it here would only pin a fabricated collaborator
 * return, not a real contract. That arm is left uncovered.
 */

const mocks = vi.hoisted(() => ({
  withDb: Object.assign(vi.fn(), { tx: vi.fn() }),
}));

vi.mock("@repo/database", () => ({
  withDb: mocks.withDb,
  // `resolveEventReadUpperBound` (via getCommandEvents) tags its query with
  // this at runtime; the tagged value is discarded by the mocked
  // `$queryRaw` below, so the stub only needs to be callable.
  Prisma: { sql: (...args: unknown[]) => args },
}));

vi.mock("@repo/observability/log", () => ({
  log: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

vi.mock("@repo/observability/telemetry/emitter", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("@repo/observability/telemetry/emitter")
    >();
  return {
    ...actual,
    emitCommandLifecycleEvent: vi.fn(actual.emitCommandLifecycleEvent),
  };
});

vi.mock("@/lib/desktop-command-transitions", () => ({
  resolveCommandUpdate: vi.fn(),
}));

vi.mock("@/lib/desktop-command-lookup", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/lib/desktop-command-lookup")>();
  return {
    ...actual,
    // Spied (real implementation preserved) so a mutant that always takes
    // the `if (idempotencyKey)` branch in `createCommand` is observable even
    // when no idempotencyKey was supplied.
    rememberIdempotentCommand: vi.fn(actual.rememberIdempotentCommand),
  };
});

import { desktopCommandStore } from "@/lib/desktop-command-store";

const TARGET_ID = "target-1";
const COMMAND_ID = "command-1";
const CREATED_AT = new Date("2026-08-22T12:00:00.000Z");
const FINISHED_AT = new Date("2026-08-22T12:05:00.000Z");
const GATEWAY_SESSION_ID = "01920000-0000-7000-8000-000000000099";
const CONTEXT = { gatewaySessionId: GATEWAY_SESSION_ID, schemaVersion: "1" };
const STARTED_AT = new Date("2026-08-22T12:01:00.000Z");

function commandInput(
  over: Record<string, unknown> = {}
): CreateDesktopCommandInput {
  return {
    operationId: "health_check",
    method: "POST",
    path: "/api/gateway/health-check",
    headers: {},
    body: null,
    ...over,
  } as CreateDesktopCommandInput;
}

function storedRow(
  overrides: Partial<StoredCommandRow> = {}
): StoredCommandRow {
  return {
    id: COMMAND_ID,
    computeTargetId: TARGET_ID,
    operationId: "health_check",
    status: DesktopCommandStatus.Queued,
    requestPayload: commandInput(),
    error: null,
    createdAt: CREATED_AT,
    queuedAt: CREATED_AT,
    startedAt: null,
    finishedAt: null,
    lastSequenceAcked: 0,
    idempotencyKey: null,
    requestFingerprint: "fp",
    ...overrides,
  };
}

function uniqueViolation(): Error {
  return Object.assign(new Error("Unique constraint failed"), {
    code: "P2002",
  });
}

type CommandDelegate = {
  findFirst: ReturnType<typeof vi.fn>;
  findUnique: ReturnType<typeof vi.fn>;
  create: ReturnType<typeof vi.fn>;
  update: ReturnType<typeof vi.fn>;
  updateMany: ReturnType<typeof vi.fn>;
};

type EventDelegate = {
  create: ReturnType<typeof vi.fn>;
};

function installDb(): {
  desktopCommand: CommandDelegate;
  desktopCommandEvent: EventDelegate;
  $queryRaw: ReturnType<typeof vi.fn>;
} {
  const desktopCommand: CommandDelegate = {
    findFirst: vi.fn(),
    findUnique: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    updateMany: vi.fn(),
  };
  const desktopCommandEvent: EventDelegate = { create: vi.fn() };
  // Stubbed for `resolveEventReadUpperBound`'s sizing probe (getCommandEvents).
  // Defaults to "no events stored" so tests that never touch this path don't
  // need to know it exists.
  const $queryRaw = vi.fn().mockResolvedValue([]);
  const db = { desktopCommand, desktopCommandEvent, $queryRaw };
  mocks.withDb.mockImplementation((callback: (client: unknown) => unknown) =>
    callback(db)
  );
  mocks.withDb.tx.mockImplementation((callback: (client: unknown) => unknown) =>
    callback(db)
  );
  return { desktopCommand, desktopCommandEvent, $queryRaw };
}

/** Every `log.info` payload emitted during a call, parsed. */
function infoPayloads(): Record<string, unknown>[] {
  return vi
    .mocked(log.info)
    .mock.calls.map(([json]) => JSON.parse(json) as Record<string, unknown>);
}

describe("desktopCommandStore.ingestCommandEvent — event-insert conflict recovery (ISS-10513)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    desktopCommandStore.__resetForTests();
  });

  it("treats a P2002 on the event insert as a duplicate of the same sequence", async () => {
    const { desktopCommand, desktopCommandEvent } = installDb();
    desktopCommand.findUnique.mockResolvedValue(
      storedRow({ lastSequenceAcked: 0 })
    );
    desktopCommandEvent.create.mockRejectedValue(uniqueViolation());

    const result = await desktopCommandStore.ingestCommandEvent({
      commandId: COMMAND_ID,
      eventType: "chunk",
      data: null,
      sequence: 1,
    });

    expect(result).toEqual({ accepted: true, duplicate: true, sequence: 1 });
    // Treated as a replay: no status transition is attempted for it.
    expect(desktopCommand.update).not.toHaveBeenCalled();
  });

  it("rethrows a non-P2002 failure from the event insert unchanged", async () => {
    const { desktopCommand, desktopCommandEvent } = installDb();
    desktopCommand.findUnique.mockResolvedValue(
      storedRow({ lastSequenceAcked: 0 })
    );
    desktopCommandEvent.create.mockRejectedValue(
      Object.assign(new Error("connection lost"), { code: "P1001" })
    );

    await expect(
      desktopCommandStore.ingestCommandEvent({
        commandId: COMMAND_ID,
        eventType: "chunk",
        data: null,
        sequence: 1,
      })
    ).rejects.toThrow("connection lost");
  });
});

describe("desktopCommandStore.ingestCommandEvent — unknown command and stale sequence (ISS-10513)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    desktopCommandStore.__resetForTests();
  });

  it("rejects an event for a command that does not exist", async () => {
    const { desktopCommand } = installDb();
    desktopCommand.findUnique.mockResolvedValue(null);

    const result = await desktopCommandStore.ingestCommandEvent({
      commandId: COMMAND_ID,
      eventType: "chunk",
      data: null,
    });

    expect(result).toEqual({ accepted: false, reason: "unknown_command" });
    // Unscoped: reads by id alone, via `findUnique`, never `findFirst`.
    expect(desktopCommand.findUnique).toHaveBeenCalledWith({
      where: { id: COMMAND_ID },
      select: STORED_COMMAND_SELECT,
    });
    expect(desktopCommand.findFirst).not.toHaveBeenCalled();
    expect(log.warn).toHaveBeenCalledWith(
      "ingestCommandEvent: unknown command",
      {
        commandId: COMMAND_ID,
        computeTargetId: undefined,
        errorClass: ErrorClass.Execution,
      }
    );
  });

  it("queries the row scoped to computeTargetId when the event names one", async () => {
    const { desktopCommand } = installDb();
    desktopCommand.findFirst.mockResolvedValue(
      storedRow({ lastSequenceAcked: 5 })
    );

    const result = await desktopCommandStore.ingestCommandEvent({
      commandId: COMMAND_ID,
      eventType: "chunk",
      data: null,
      sequence: 3,
      computeTargetId: TARGET_ID,
    });

    expect(result).toEqual({ accepted: true, duplicate: true, sequence: 3 });
    expect(desktopCommand.findFirst).toHaveBeenCalledWith({
      where: { id: COMMAND_ID, computeTargetId: TARGET_ID },
      select: STORED_COMMAND_SELECT,
    });
    expect(desktopCommand.findUnique).not.toHaveBeenCalled();
  });

  it("reports a duplicate for an event sequence already acknowledged", async () => {
    const { desktopCommand } = installDb();
    desktopCommand.findUnique.mockResolvedValue(
      storedRow({ lastSequenceAcked: 5 })
    );

    const result = await desktopCommandStore.ingestCommandEvent({
      commandId: COMMAND_ID,
      eventType: "chunk",
      data: null,
      sequence: 3,
    });

    expect(result).toEqual({ accepted: true, duplicate: true, sequence: 3 });
    expect(desktopCommand.update).not.toHaveBeenCalled();
  });

  it("logs a bounded warning and reports the gap for an out-of-order sequence", async () => {
    const { desktopCommand } = installDb();
    desktopCommand.findUnique.mockResolvedValue(
      storedRow({ lastSequenceAcked: 2 })
    );

    const result = await desktopCommandStore.ingestCommandEvent({
      commandId: COMMAND_ID,
      eventType: "chunk",
      data: null,
      sequence: 5,
    });

    expect(result).toEqual({
      accepted: false,
      reason: "sequence_gap",
      expected: 3,
    });
    expect(desktopCommand.update).not.toHaveBeenCalled();
    expect(log.warn).toHaveBeenCalledWith(
      "ingestCommandEvent: sequence gap detected",
      {
        commandId: COMMAND_ID,
        sequence: 5,
        expected: 3,
        errorClass: ErrorClass.Protocol,
      }
    );
  });
});

describe("desktopCommandStore.ingestCommandEvent — lifecycle dispatch by transition status (ISS-10513)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    desktopCommandStore.__resetForTests();
  });

  function setUpSuccessfulEventWrite() {
    const { desktopCommand, desktopCommandEvent } = installDb();
    desktopCommand.findUnique.mockResolvedValue(
      storedRow({ lastSequenceAcked: 0 })
    );
    desktopCommandEvent.create.mockResolvedValue({ createdAt: CREATED_AT });
    desktopCommand.update.mockResolvedValue({ id: COMMAND_ID });
    return desktopCommand;
  }

  it("logs a command.failed event and persists the transition's error", async () => {
    const desktopCommand = setUpSuccessfulEventWrite();
    vi.mocked(resolveCommandUpdate).mockReturnValue({
      status: DesktopCommandStatus.Failed,
      finishedAt: FINISHED_AT,
      error: "boom",
    });

    const result = await desktopCommandStore.ingestCommandEvent({
      commandId: COMMAND_ID,
      eventType: "error",
      data: { terminal: true, error: "boom" },
      sequence: 1,
      context: CONTEXT,
    });

    if (!(result.accepted && !result.duplicate)) {
      throw new Error("expected an accepted, non-duplicate result");
    }
    expect(result.nextStatus).toBe(DesktopCommandStatus.Failed);

    const updateCall = desktopCommand.update.mock.calls[0][0];
    expect(updateCall.data.status).toBe(DesktopCommandStatus.Failed);
    expect(updateCall.data.error).toBe("boom");
    expect(updateCall.data.finishedAt).toEqual(FINISHED_AT);
    expect(updateCall.select).toEqual({ id: true });

    expect(log.error).toHaveBeenCalledTimes(1);
    const [errorPayload] = vi.mocked(log.error).mock.calls[0];
    expect(JSON.parse(errorPayload).category).toBe(
      TelemetryCategory.CommandFailed
    );
    expect(log.warn).not.toHaveBeenCalled();
  });

  it("emits no lifecycle event for a transition status outside done/failed/expired, and omits an absent error key", async () => {
    const desktopCommand = setUpSuccessfulEventWrite();
    vi.mocked(resolveCommandUpdate).mockReturnValue({
      status: DesktopCommandStatus.Cancelled,
      startedAt: STARTED_AT,
      finishedAt: FINISHED_AT,
    });

    await desktopCommandStore.ingestCommandEvent({
      commandId: COMMAND_ID,
      eventType: "result",
      data: { terminal: true, cancelled: true },
      sequence: 1,
      context: CONTEXT,
    });

    const updateData = desktopCommand.update.mock.calls[0][0].data;
    // A truthy `startedAt` on the transition must be persisted verbatim.
    expect(updateData.startedAt).toEqual(STARTED_AT);
    // No `error` on the transition -> the written row must not carry the key
    // at all, not an `error: undefined`.
    expect(Object.hasOwn(updateData, "error")).toBe(false);

    // The queue-metric emit (log.info, "command_state_transition") is a
    // separate contract from the per-status lifecycle dispatch and still
    // fires for any transition with a status. Asserted on its own so it
    // cannot be mistaken for the lifecycle-event assertion below.
    expect(log.info).toHaveBeenCalledTimes(1);

    // Asserted directly on the collaborator, not inferred from log-call
    // counts: the dispatch table in `emitCommandLifecycleEventForStatus`
    // falls through silently for a status outside done/failed/expired.
    expect(emitCommandLifecycleEvent).not.toHaveBeenCalled();
  });
});

describe("desktopCommandStore.createCommand — idempotency cache and queued telemetry (ISS-10513)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    desktopCommandStore.__resetForTests();
  });

  it("caches a newly created command against its idempotency key for a same-payload retry", async () => {
    const { desktopCommand } = installDb();
    desktopCommand.findFirst.mockResolvedValue(null);
    desktopCommand.create.mockImplementation(
      (args: { data: Record<string, unknown> }) =>
        Promise.resolve({ ...storedRow(), ...args.data, id: COMMAND_ID })
    );

    const input = commandInput({ idempotencyKey: "retry-key" });
    const first = await desktopCommandStore.createCommand(TARGET_ID, input);
    expect(first.deduped).toBe(false);

    desktopCommand.create.mockClear();
    desktopCommand.findFirst.mockClear();
    desktopCommand.findUnique.mockResolvedValue(
      storedRow({ idempotencyKey: "retry-key" })
    );

    const second = await desktopCommandStore.createCommand(TARGET_ID, input);

    expect(second).toEqual({
      command: expect.objectContaining({ commandId: COMMAND_ID }),
      deduped: true,
    });
    // The cache short-circuits the retry entirely — no fresh insert, no
    // fallback DB dedupe query.
    expect(desktopCommand.create).not.toHaveBeenCalled();
    expect(desktopCommand.findFirst).not.toHaveBeenCalled();
  });

  it("emits a command.queued lifecycle event when telemetry context is provided", async () => {
    const { desktopCommand } = installDb();
    desktopCommand.create.mockImplementation(
      (args: { data: Record<string, unknown> }) =>
        Promise.resolve({ ...storedRow(), ...args.data, id: COMMAND_ID })
    );

    await desktopCommandStore.createCommand(TARGET_ID, commandInput(), CONTEXT);

    expect(log.info).toHaveBeenCalledTimes(1);
    const payload = infoPayloads()[0];
    expect(payload.category).toBe(TelemetryCategory.CommandQueued);
    expect(payload.trace).toEqual(
      expect.objectContaining({
        commandId: COMMAND_ID,
        operationId: "health_check",
        computeTargetId: TARGET_ID,
      })
    );
    // No idempotencyKey on the input: the cache must not gain an entry for it.
    expect(rememberIdempotentCommand).not.toHaveBeenCalled();
  });
});

describe("desktopCommandStore.acknowledgeCommand — not-found, terminal, and default fields (ISS-10513)", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  beforeEach(() => {
    vi.clearAllMocks();
    desktopCommandStore.__resetForTests();
  });

  it("returns null when the command does not exist", async () => {
    const { desktopCommand } = installDb();
    desktopCommand.findFirst.mockResolvedValue(null);

    const result = await desktopCommandStore.acknowledgeCommand(
      COMMAND_ID,
      true,
      undefined,
      TARGET_ID
    );

    expect(result).toBeNull();
    expect(desktopCommand.updateMany).not.toHaveBeenCalled();
  });

  it("returns the existing summary without writing when the command is already terminal", async () => {
    const { desktopCommand } = installDb();
    desktopCommand.findFirst.mockResolvedValue(
      storedRow({ status: DesktopCommandStatus.Done, finishedAt: CREATED_AT })
    );

    const result = await desktopCommandStore.acknowledgeCommand(
      COMMAND_ID,
      true,
      undefined,
      TARGET_ID
    );

    expect(result).toEqual(
      expect.objectContaining({
        commandId: COMMAND_ID,
        status: DesktopCommandStatus.Done,
      })
    );
    expect(desktopCommand.updateMany).not.toHaveBeenCalled();
  });

  it("stamps ackedAt with wall-clock now and defaults the rejection reason when the row has no queuedAt", async () => {
    vi.useFakeTimers();
    const NOW = new Date("2026-08-22T13:00:00.000Z");
    vi.setSystemTime(NOW);

    const { desktopCommand } = installDb();
    // pins current behavior; looks odd because only rows written before
    // ISS-7223 added `queuedAt` reach this fallback.
    const row = storedRow({
      queuedAt: null,
      status: DesktopCommandStatus.Accepted,
    });
    desktopCommand.findFirst
      .mockResolvedValueOnce(row)
      .mockResolvedValueOnce(row);
    desktopCommand.updateMany.mockResolvedValue({ count: 1 });

    await desktopCommandStore.acknowledgeCommand(
      COMMAND_ID,
      false,
      undefined,
      TARGET_ID
    );

    const data = desktopCommand.updateMany.mock.calls[0][0].data;
    expect(data.ackedAt).toEqual(NOW);
    expect(data.error).toBe("Command rejected");
  });
});

describe("desktopCommandStore.acknowledgeCommand — computeTargetId fallback and re-fetch races (ISS-10513)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    desktopCommandStore.__resetForTests();
  });

  it("falls back to the command's own computeTargetId in the update guard and both telemetry emits, and returns null when the row is gone by the final read", async () => {
    const { desktopCommand } = installDb();
    const row = storedRow({ status: DesktopCommandStatus.Queued });
    // No computeTargetId param below, so both the initial lookup and the
    // final re-fetch go through the unscoped `findUnique` path.
    desktopCommand.findUnique
      .mockResolvedValueOnce(row) // initial read
      .mockResolvedValueOnce(null); // final re-fetch: the row disappeared
    desktopCommand.updateMany.mockResolvedValue({ count: 1 });

    const result = await desktopCommandStore.acknowledgeCommand(
      COMMAND_ID,
      true,
      undefined,
      undefined,
      CONTEXT
    );

    expect(result).toBeNull();

    const where = desktopCommand.updateMany.mock.calls[0][0].where;
    expect(Object.hasOwn(where, "computeTargetId")).toBe(false);

    const payloads = infoPayloads();
    const ackPayload = payloads.find(
      (p) => p.category === TelemetryCategory.CommandAcknowledged
    );
    expect(ackPayload?.trace).toEqual(
      expect.objectContaining({ computeTargetId: TARGET_ID })
    );
    const metricPayload = payloads.find(
      (p) => p.metric === "command_state_transition"
    );
    expect(metricPayload?.computeTargetId).toBe(TARGET_ID);
  });

  it("re-fetches and returns null when the conditional update matches no row and the command is gone", async () => {
    const { desktopCommand } = installDb();
    const row = storedRow({ status: DesktopCommandStatus.Accepted });
    desktopCommand.findFirst
      .mockResolvedValueOnce(row) // initial read
      .mockResolvedValueOnce(null); // re-fetch after a no-op update
    desktopCommand.updateMany.mockResolvedValue({ count: 0 });

    const result = await desktopCommandStore.acknowledgeCommand(
      COMMAND_ID,
      true,
      undefined,
      TARGET_ID
    );

    expect(result).toBeNull();
  });

  it("falls back to the stored computeTargetId when the acknowledgement lifecycle emit itself throws", async () => {
    const { desktopCommand } = installDb();
    const row = storedRow({ status: DesktopCommandStatus.Accepted });
    desktopCommand.findUnique.mockResolvedValue(row);
    desktopCommand.updateMany.mockResolvedValue({ count: 1 });
    vi.mocked(emitCommandLifecycleEvent).mockImplementationOnce(() => {
      throw new Error("emit boom");
    });

    const result = await desktopCommandStore.acknowledgeCommand(
      COMMAND_ID,
      true,
      undefined,
      undefined,
      CONTEXT
    );

    // The emit failure is swallowed — acknowledgement still completes.
    expect(result).toEqual(expect.objectContaining({ commandId: COMMAND_ID }));
    expect(log.warn).toHaveBeenCalledWith(
      "CommandAcknowledged lifecycle emit failed",
      expect.objectContaining({
        commandId: COMMAND_ID,
        computeTargetId: TARGET_ID,
        error: expect.any(Error),
      })
    );
  });
});

describe("desktopCommandStore.getCommandById (ISS-10513)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    desktopCommandStore.__resetForTests();
  });

  it("returns a summary when the command exists", async () => {
    const { desktopCommand } = installDb();
    desktopCommand.findUnique.mockResolvedValue(storedRow());

    const result = await desktopCommandStore.getCommandById(COMMAND_ID);

    expect(result).toEqual(expect.objectContaining({ commandId: COMMAND_ID }));
  });

  it("returns null when the command does not exist", async () => {
    const { desktopCommand } = installDb();
    desktopCommand.findUnique.mockResolvedValue(null);

    const result = await desktopCommandStore.getCommandById(COMMAND_ID);

    expect(result).toBeNull();
  });
});

describe("desktopCommandStore.getCommandEvents (ISS-10513)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    desktopCommandStore.__resetForTests();
  });

  it("continues past the not-found guard and reads events once the command exists", async () => {
    const { desktopCommand } = installDb();
    desktopCommand.findFirst.mockResolvedValue(storedRow());

    const result = await desktopCommandStore.getCommandEvents(
      TARGET_ID,
      COMMAND_ID
    );

    // No events stored (the sizing probe returns nothing), but the call
    // reaches the read at all only because `!command` was false.
    expect(result).toEqual([]);
  });
});

describe("desktopCommandStore.ClientCommandIdConflictError (ISS-10513)", () => {
  it("honors an explicitly supplied message", () => {
    const error = new desktopCommandStore.ClientCommandIdConflictError(
      "custom message"
    );
    expect(error.message).toBe("custom message");
  });
});
