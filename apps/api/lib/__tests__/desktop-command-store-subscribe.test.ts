import { DesktopCommandStatus } from "@repo/api/src/types/compute-target";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * ISS-5291: `subscribeCommandEvents` and the operation-id lookups.
 *
 * The subscription is the read side of desktop command streaming: a client
 * attaches mid-flight and must receive every event exactly once — the ones
 * already persisted AND the ones that land while the replay query is running.
 *
 * The source comment names the race it is written against ("Register the
 * listener BEFORE replaying from DB so no events published between the DB query
 * and registration are missed"), and the code pays for that ordering with a
 * de-duplication set. Nothing tested either half. Both failure modes are silent
 * to the producer and corrupt the stream for the consumer:
 *   - register AFTER the replay and an event lands in the gap: lost forever,
 *     because replay already ran and the listener did not exist yet;
 *   - register BEFORE without the de-dup set: the same event is delivered
 *     twice, once live and once from the replay it was already written into.
 *
 * The test drives the race directly — it publishes a live event from inside the
 * replay query — rather than asserting the shape of the wrapper.
 */

const { mockFindFirst, mockFindUnique, mockEventFindMany, mockEventCreate } =
  vi.hoisted(() => ({
    mockFindFirst: vi.fn(),
    mockFindUnique: vi.fn(),
    mockEventFindMany: vi.fn(),
    mockEventCreate: vi.fn(),
  }));

const mockUpdate = vi.fn();

type EventReadArgs = {
  where?: { sequence?: { gt?: number; lte?: number } };
};

const db = {
  desktopCommand: {
    findFirst: mockFindFirst,
    findUnique: mockFindUnique,
    update: mockUpdate,
  },
  desktopCommandEvent: {
    // `mockEventFindMany` still receives the exact args every assertion below
    // names; the `sequence` bounds are applied to its RESULT. Without that a
    // fixture declared once with `mockResolvedValue` re-serves rows the caller
    // has already consumed, and the replay loop — which now pages until a read
    // comes back empty — would deliver them twice. A real read cannot do that,
    // so honouring the cursor here keeps the fake from inventing a race.
    findMany: async (args: EventReadArgs) => {
      const rows = await mockEventFindMany(args);
      if (!Array.isArray(rows)) {
        return rows;
      }
      const gt = args?.where?.sequence?.gt;
      const lte = args?.where?.sequence?.lte;
      return rows.filter(
        (row: { sequence: number }) =>
          (gt === undefined || row.sequence > gt) &&
          (lte === undefined || row.sequence <= lte)
      );
    },
    create: mockEventCreate,
  },
  // ISS-8547: the event read resolves how far it may go from `octet_length`
  // before fetching any payload. This suite owns the subscribe race, not that
  // bound, so the probe answers permissively; the bound has its own modelling
  // fake in `desktop-command-store-event-paging.test.ts`.
  $queryRaw: vi.fn(() =>
    Promise.resolve([{ bytes: 1, sequence: Number.MAX_SAFE_INTEGER }])
  ),
};

vi.mock("@repo/database", () => ({
  Prisma: {
    sql: (strings: TemplateStringsArray, ...values: unknown[]) => ({
      strings,
      values,
    }),
  },
  withDb: Object.assign((fn: (client: unknown) => unknown) => fn(db), {
    tx: (fn: (client: unknown) => unknown) => fn(db),
  }),
}));

vi.mock("@repo/observability/log", () => ({
  log: { error: vi.fn(), info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

import { desktopCommandStore } from "../desktop-command-store";

const TARGET_ID = "target-1";
/** A second target, used to prove scoping predicates actually exclude. */
const FOREIGN_TARGET_ID = "target-2";
type PrismaWhere = Record<string, unknown>;
let nextCommandId = 0;

/** A fresh command id per test: the subscriber map is keyed by it at module scope. */
function freshCommandId(): string {
  nextCommandId += 1;
  return `command-${nextCommandId}`;
}

function commandRow(commandId: string, over: Record<string, unknown> = {}) {
  return {
    id: commandId,
    computeTargetId: TARGET_ID,
    operationId: `operation-${commandId}`,
    method: "POST",
    path: "/api/gateway/git/status",
    // Must be a real DesktopCommandStatus. An unrecognized value folds to
    // `failed` in toDesktopCommandStatus, and `failed` is terminal — so
    // resolveCommandUpdate would return {} for every ingest and no test here
    // would exercise the live state machinery it means to drive.
    status: DesktopCommandStatus.Queued,
    lastSequenceAcked: 0,
    createdAt: new Date("2026-08-01T00:00:00.000Z"),
    updatedAt: new Date("2026-08-01T00:00:00.000Z"),
    ...over,
  };
}

/**
 * The Prisma column is `eventPayload`; `data` is the WIRE field getCommandEvents
 * maps it onto. A fixture returning `data` replays `data: undefined` for every
 * event, so any assertion on the replayed payload would be vacuous.
 */
function eventRow(commandId: string, sequence: number) {
  return {
    commandId,
    sequence,
    eventType: "chunk",
    eventPayload: { chunk: `chunk-${sequence}` },
    createdAt: new Date("2026-08-01T00:00:00.000Z"),
  };
}

/** The wire shape `eventRow(commandId, sequence)` must replay as. */
function replayedChunk(sequence: number) {
  return { chunk: `chunk-${sequence}` };
}

// The store keeps module-level state (the subscriber map and the operation-id
// cache) that outlives a single test. Reset it before EVERY test so a case is
// hermetic even when the runner executes it more than once in the same module —
// which is exactly what Datadog's Early Flake Detection does to new tests.
beforeEach(() => {
  desktopCommandStore.__resetForTests();
});

describe("subscribeCommandEvents — attaching", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockEventFindMany.mockResolvedValue([]);
  });

  it("returns null and registers nothing for a command the target does not own", async () => {
    const commandId = freshCommandId();
    // The command EXISTS — it just belongs to another target. A mock that
    // answered null to every query would pass this test even with the scoping
    // predicate deleted; the row has to be reachable by an unscoped lookup so
    // that dropping `computeTargetId` genuinely finds it.
    const foreignRow = commandRow(commandId, {
      computeTargetId: FOREIGN_TARGET_ID,
    });
    mockFindFirst.mockImplementation(({ where }: { where: PrismaWhere }) =>
      Promise.resolve(where.computeTargetId === TARGET_ID ? null : foreignRow)
    );
    mockFindUnique.mockResolvedValue(foreignRow);

    const unsubscribe = await desktopCommandStore.subscribeCommandEvents(
      TARGET_ID,
      commandId,
      vi.fn()
    );

    // Org/target scoping: a caller must not be able to attach to another
    // target's stream, and must not learn whether the command exists.
    expect(unsubscribe).toBeNull();
    expect(mockEventFindMany).not.toHaveBeenCalled();
  });

  it("replays persisted events in order, then returns an unsubscribe", async () => {
    const commandId = freshCommandId();
    mockFindFirst.mockResolvedValue(commandRow(commandId));
    mockEventFindMany.mockResolvedValue([
      eventRow(commandId, 1),
      eventRow(commandId, 2),
    ]);
    const listener = vi.fn();

    const unsubscribe = await desktopCommandStore.subscribeCommandEvents(
      TARGET_ID,
      commandId,
      listener
    );

    expect(typeof unsubscribe).toBe("function");
    expect(listener.mock.calls.map((call) => call[0].sequence)).toEqual([1, 2]);
    // The payload must survive the eventPayload -> data mapping. Asserting only
    // the sequence would pass even if every replayed event carried no payload.
    expect(listener.mock.calls.map((call) => call[0].data)).toEqual([
      replayedChunk(1),
      replayedChunk(2),
    ]);
  });

  it("forwards afterSequence so a resuming client is not re-sent what it has", async () => {
    const commandId = freshCommandId();
    mockFindFirst.mockResolvedValue(commandRow(commandId));

    await desktopCommandStore.subscribeCommandEvents(
      TARGET_ID,
      commandId,
      vi.fn(),
      { afterSequence: 7 }
    );

    // `gt` stays exact — that is the contract this case is named for. The read
    // also carries an `lte` now, the upper end of the byte budget it resolved
    // before fetching (ISS-8547), so the matcher admits it and asserts it is
    // really there rather than widening to any `sequence` shape at all.
    const readArgs = mockEventFindMany.mock.calls[0]?.[0] as
      | EventReadArgs
      | undefined;

    expect(readArgs?.where?.sequence?.gt).toBe(7);
    expect(typeof readArgs?.where?.sequence?.lte).toBe("number");
  });

  it("skips the replay query entirely when replay is disabled", async () => {
    const commandId = freshCommandId();
    mockFindFirst.mockResolvedValue(commandRow(commandId));

    const unsubscribe = await desktopCommandStore.subscribeCommandEvents(
      TARGET_ID,
      commandId,
      vi.fn(),
      { replay: false }
    );

    // A live-only subscriber must not pay for a history read it discards.
    expect(typeof unsubscribe).toBe("function");
    expect(mockEventFindMany).not.toHaveBeenCalled();
  });
});

describe("subscribeCommandEvents — the replay/live race", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockEventCreate.mockImplementation(({ data }: { data: unknown }) =>
      Promise.resolve(data)
    );
    mockUpdate.mockResolvedValue({});
  });

  it("delivers an event that lands DURING the replay exactly once", async () => {
    const commandId = freshCommandId();
    mockFindFirst.mockResolvedValue(commandRow(commandId));
    mockFindUnique.mockResolvedValue(commandRow(commandId));
    const listener = vi.fn();

    // The replay query is the race window. Publishing sequence 1 from inside it
    // reproduces exactly what the source comment describes: the event is
    // delivered live to the already-registered listener, and is ALSO in the
    // rows the replay is about to return.
    // `Once`, because the race window is the FIRST replay query. The replay now
    // pages until a read comes back empty, and a fixture that re-published on
    // every call would be staging a second, different race rather than this one.
    mockEventFindMany
      .mockImplementationOnce(async () => {
        await desktopCommandStore.ingestCommandEvent({
          commandId,
          computeTargetId: TARGET_ID,
          eventType: "chunk",
          data: { chunk: "chunk-1" },
        });
        return [eventRow(commandId, 1), eventRow(commandId, 2)];
      })
      .mockImplementation(async () => [
        eventRow(commandId, 1),
        eventRow(commandId, 2),
      ]);

    await desktopCommandStore.subscribeCommandEvents(
      TARGET_ID,
      commandId,
      listener
    );

    // Exactly once each. Without the de-dup set sequence 1 arrives twice;
    // without the register-before-replay ordering it never arrives at all.
    expect(listener.mock.calls.map((call) => call[0].sequence)).toEqual([1, 2]);
  });

  it("delivers an event that lands DURING the replay but is MISSING from its rows", async () => {
    const commandId = freshCommandId();
    mockFindFirst.mockResolvedValue(commandRow(commandId));
    mockFindUnique.mockResolvedValue(commandRow(commandId));
    const listener = vi.fn();

    // The overlap case above cannot fail if registration moves after the query,
    // because sequence 1 is in the rows findMany returns either way. Here the
    // replay's read snapshot predates the write, so its rows EXCLUDE sequence 1
    // and the live notification is the only path by which it can arrive.
    // `Once` for the same reason as the case above.
    mockEventFindMany
      .mockImplementationOnce(async () => {
        await desktopCommandStore.ingestCommandEvent({
          commandId,
          computeTargetId: TARGET_ID,
          eventType: "chunk",
          data: { chunk: "chunk-1" },
        });
        return [eventRow(commandId, 2)];
      })
      .mockImplementation(async () => [eventRow(commandId, 2)]);

    await desktopCommandStore.subscribeCommandEvents(
      TARGET_ID,
      commandId,
      listener
    );

    // Registering AFTER the replay loses sequence 1 outright and yields [2].
    expect(listener.mock.calls.map((call) => call[0].sequence)).toEqual([1, 2]);
  });

  it("does not de-duplicate when replay is disabled", async () => {
    const commandId = freshCommandId();
    mockFindFirst.mockResolvedValue(commandRow(commandId));
    mockFindUnique.mockResolvedValue(commandRow(commandId));
    const listener = vi.fn();

    await desktopCommandStore.subscribeCommandEvents(
      TARGET_ID,
      commandId,
      listener,
      { replay: false }
    );
    await desktopCommandStore.ingestCommandEvent({
      commandId,
      computeTargetId: TARGET_ID,
      eventType: "chunk",
      data: { chunk: "chunk-1" },
    });

    // With no replay there is nothing to collide with, so the raw listener is
    // registered and the live event passes straight through.
    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener.mock.calls[0][0].sequence).toBe(1);
  });

  it("advances the queued command to running as the first event is ingested", async () => {
    const commandId = freshCommandId();
    mockFindFirst.mockResolvedValue(commandRow(commandId));
    mockFindUnique.mockResolvedValue(commandRow(commandId));
    mockEventFindMany.mockResolvedValue([]);

    await desktopCommandStore.subscribeCommandEvents(
      TARGET_ID,
      commandId,
      vi.fn()
    );
    await desktopCommandStore.ingestCommandEvent({
      commandId,
      computeTargetId: TARGET_ID,
      eventType: "chunk",
      data: { chunk: "chunk-1" },
    });

    // Pins the fixture as a LIVE command. A terminal status short-circuits
    // resolveCommandUpdate to {}, which would silently reduce every ingest in
    // this file to a no-op write and leave the transition untested.
    expect(mockUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: DesktopCommandStatus.Running,
        }),
      })
    );
  });

  it("delivers a live event to every attached subscriber", async () => {
    const commandId = freshCommandId();
    mockFindFirst.mockResolvedValue(commandRow(commandId));
    mockFindUnique.mockResolvedValue(commandRow(commandId));
    mockEventFindMany.mockResolvedValue([]);
    const first = vi.fn();
    const second = vi.fn();

    await desktopCommandStore.subscribeCommandEvents(
      TARGET_ID,
      commandId,
      first
    );
    await desktopCommandStore.subscribeCommandEvents(
      TARGET_ID,
      commandId,
      second
    );
    await desktopCommandStore.ingestCommandEvent({
      commandId,
      computeTargetId: TARGET_ID,
      eventType: "chunk",
      data: { chunk: "chunk-1" },
    });

    expect(first).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledTimes(1);
  });
});

describe("subscribeCommandEvents — unsubscribing", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockEventFindMany.mockResolvedValue([]);
    mockEventCreate.mockImplementation(({ data }: { data: unknown }) =>
      Promise.resolve(data)
    );
    mockUpdate.mockResolvedValue({});
  });

  it("stops delivery to the unsubscribed listener only", async () => {
    const commandId = freshCommandId();
    mockFindFirst.mockResolvedValue(commandRow(commandId));
    mockFindUnique.mockResolvedValue(commandRow(commandId));
    const leaving = vi.fn();
    const staying = vi.fn();

    const unsubscribe = await desktopCommandStore.subscribeCommandEvents(
      TARGET_ID,
      commandId,
      leaving
    );
    await desktopCommandStore.subscribeCommandEvents(
      TARGET_ID,
      commandId,
      staying
    );
    unsubscribe?.();
    await desktopCommandStore.ingestCommandEvent({
      commandId,
      computeTargetId: TARGET_ID,
      eventType: "chunk",
      data: { chunk: "chunk-1" },
    });

    expect(leaving).not.toHaveBeenCalled();
    expect(staying).toHaveBeenCalledTimes(1);
  });

  it("is safe to call twice", async () => {
    const commandId = freshCommandId();
    mockFindFirst.mockResolvedValue(commandRow(commandId));

    const unsubscribe = await desktopCommandStore.subscribeCommandEvents(
      TARGET_ID,
      commandId,
      vi.fn()
    );

    // The second call finds the map entry already deleted and must not throw —
    // a subscriber that unsubscribes on both an explicit close and a socket
    // teardown calls it twice as a matter of course.
    //
    // NOT covered here: that the empty Set is also removed from
    // `eventSubscribers`. That map is module-private and `publishEvent`
    // short-circuits on `size === 0`, so a leaked empty entry is invisible from
    // outside — it is a memory leak with no behavioral signature. Catching it
    // would need the map exported for tests, which is a production change.
    expect(() => {
      unsubscribe?.();
      unsubscribe?.();
    }).not.toThrow();
  });

  it("unregisters the listener when the replay query rejects", async () => {
    const commandId = freshCommandId();
    mockFindFirst.mockResolvedValue(commandRow(commandId));
    mockFindUnique.mockResolvedValue(commandRow(commandId));
    const listener = vi.fn();
    const failure = new Error("replay query failed");
    mockEventFindMany.mockRejectedValue(failure);

    await expect(
      desktopCommandStore.subscribeCommandEvents(TARGET_ID, commandId, listener)
    ).rejects.toThrow(failure);

    // Registration happens BEFORE the replay, and the throw escapes before the
    // caller is handed a cleanup handle — so nothing else can ever remove this
    // listener. It must not still be attached.
    await desktopCommandStore.ingestCommandEvent({
      commandId,
      computeTargetId: TARGET_ID,
      eventType: "chunk",
      data: { chunk: "chunk-1" },
    });

    expect(listener).not.toHaveBeenCalled();
  });

  it("leaves no listener behind once the last subscriber detaches", async () => {
    const commandId = freshCommandId();
    mockFindFirst.mockResolvedValue(commandRow(commandId));
    mockFindUnique.mockResolvedValue(commandRow(commandId));
    const listener = vi.fn();

    const unsubscribe = await desktopCommandStore.subscribeCommandEvents(
      TARGET_ID,
      commandId,
      listener
    );
    unsubscribe?.();
    await desktopCommandStore.ingestCommandEvent({
      commandId,
      computeTargetId: TARGET_ID,
      eventType: "chunk",
      data: { chunk: "chunk-1" },
    });

    expect(listener).not.toHaveBeenCalled();
  });
});
