import { DESKTOP_API_PREFIX } from "@repo/api/src/desktop-api-namespace";
import { DesktopCommandStatus } from "@repo/api/src/types/compute-target";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  count: vi.fn(),
  groupBy: vi.fn(),
  findMany: vi.fn(),
  executeRaw: vi.fn(),
  queryRaw: vi.fn(),
  targetCount: vi.fn(),
  targetFindMany: vi.fn(),
  targetUpdateMany: vi.fn(),
  updateMany: vi.fn(),
  withDb: vi.fn(),
}));

vi.mock("@repo/database", () => ({ withDb: mocks.withDb }));

import {
  acquireCommandDrainLease,
  countInFlightCommandsByTarget,
  countQueuedCommandsByTarget,
  countTargetsAwaitingSweep,
  listCommandsCrossingAckDeadline,
  listComputeTargetLastSeen,
  listIdleDrainCandidates,
  listQueueDepthSweepPage,
  listQueuedCommandsForDispatch,
  markQueueDepthSwept,
  reconcileQueuedCounters,
  renewCommandDrainLease,
  requeueUndeliveredCommands,
} from "@/lib/desktop-command-dispatch-queries";
import { IN_FLIGHT_DESKTOP_COMMAND_STATUSES } from "@/lib/desktop-command-mappers";
import { MAX_IN_FLIGHT_COMMANDS_CEILING } from "@/lib/desktop-gateway-types";

type CountInFlightCommandsForDispatch = (
  computeTargetId: string
) => Promise<number>;

const dispatchQueryModule = (await import(
  "@/lib/desktop-command-dispatch-queries"
)) as typeof import("@/lib/desktop-command-dispatch-queries") & {
  countInFlightCommandsForDispatch?: CountInFlightCommandsForDispatch;
};
const { countInFlightCommandsForDispatch } = dispatchQueryModule;

const TARGET_ID = "target-dispatch-query";
const GATEWAY_PATH_FILTER = {
  path: ["path"],
  string_starts_with: DESKTOP_API_PREFIX,
} as const;

beforeEach(() => {
  vi.clearAllMocks();
  mocks.findMany.mockResolvedValue([]);
  mocks.count.mockResolvedValue(0);
  mocks.groupBy.mockResolvedValue([]);
  mocks.executeRaw.mockResolvedValue(0);
  mocks.queryRaw.mockResolvedValue([]);
  mocks.targetCount.mockResolvedValue(0);
  mocks.targetFindMany.mockResolvedValue([]);
  mocks.targetUpdateMany.mockResolvedValue({ count: 0 });
  mocks.updateMany.mockResolvedValue({ count: 0 });
  mocks.withDb.mockImplementation(
    (
      callback: (db: {
        $executeRaw: unknown;
        $queryRaw: unknown;
        desktopCommand: unknown;
        computeTarget: unknown;
      }) => unknown
    ) =>
      callback({
        desktopCommand: {
          count: mocks.count,
          findMany: mocks.findMany,
          groupBy: mocks.groupBy,
          updateMany: mocks.updateMany,
        },
        $executeRaw: mocks.executeRaw,
        $queryRaw: mocks.queryRaw,
        computeTarget: {
          count: mocks.targetCount,
          findMany: mocks.targetFindMany,
          updateMany: mocks.targetUpdateMany,
        },
      })
  );
});

describe("desktop command dispatch query path scope", () => {
  // The queued read must stay on `(compute_target_id, status, created_at)` so
  // Postgres can push `ORDER BY … LIMIT` into the index scan and stop early. A
  // JSON-path predicate is unindexable as Prisma emits it (parameterized path,
  // runtime-built LIKE pattern), and adding one makes the planner materialize
  // the target's whole queued backlog and top-N sort it on every completion —
  // 4 buffers to 159 on a 5k backlog, growing with queue depth. This asserts
  // the exact `where`, so reintroducing the filter fails here rather than in
  // production latency.
  it("selects queued rows on the indexed columns alone, with no payload predicate", async () => {
    await listQueuedCommandsForDispatch(TARGET_ID, 2);

    expect(mocks.findMany).toHaveBeenCalledWith({
      orderBy: { createdAt: "asc" },
      select: expect.any(Object),
      take: 2,
      where: {
        computeTargetId: TARGET_ID,
        status: DesktopCommandStatus.Queued,
      },
    });
    expect(mocks.findMany.mock.calls[0][0].where).not.toHaveProperty(
      "requestPayload"
    );
  });

  // ISS-8547 §1 keeps a bound at the SINK as well as at the normalizer, because
  // `limit` arrives as a plain number on an exported function and the docstring
  // promises this read is capped in SQL. Nothing exercised it: the case above
  // passes `2`, which the `Math.min` cannot change, and the relay drain tests
  // mock this helper entirely — so deleting the `Math.min` left the whole suite
  // green while a direct caller could restore an uncapped Prisma `take`.
  it("caps the Prisma take at the ceiling however large a limit it is handed", async () => {
    await listQueuedCommandsForDispatch(TARGET_ID, Number.MAX_SAFE_INTEGER);

    expect(mocks.findMany.mock.calls[0][0].take).toBe(
      MAX_IN_FLIGHT_COMMANDS_CEILING
    );
  });

  it("passes a limit at or below the ceiling through unchanged", async () => {
    // The mutation this kills is a sink bound that also rewrites the valid path
    // — the drain must still be able to ask for fewer than the ceiling.
    await listQueuedCommandsForDispatch(
      TARGET_ID,
      MAX_IN_FLIGHT_COMMANDS_CEILING
    );
    await listQueuedCommandsForDispatch(TARGET_ID, 3);

    expect(mocks.findMany.mock.calls[0][0].take).toBe(
      MAX_IN_FLIGHT_COMMANDS_CEILING
    );
    expect(mocks.findMany.mock.calls[1][0].take).toBe(3);
  });

  // The count keeps the filter: no LIMIT to lose, and counting the legacy rows
  // a reconnect strands as `accepted` would understate free capacity forever.
  it("keeps the canonical JSON path filter for in-flight capacity", async () => {
    expect(countInFlightCommandsForDispatch).toBeTypeOf("function");
    if (!countInFlightCommandsForDispatch) {
      return;
    }

    await countInFlightCommandsForDispatch(TARGET_ID);

    expect(mocks.count).toHaveBeenCalledWith({
      where: {
        computeTargetId: TARGET_ID,
        requestPayload: GATEWAY_PATH_FILTER,
        status: {
          in: [DesktopCommandStatus.Accepted, DesktopCommandStatus.Running],
        },
      },
    });
  });
});

describe("fleet-wide queue depth reads (ISS-8453, bounded by ISS-8674)", () => {
  // ISS-8674: the whole call. This read used to `groupBy` `desktop_commands`,
  // where `take` became a LIMIT applied AFTER the aggregate — so Postgres
  // aggregated every queued row on every tick and the cap only discarded the
  // losing groups. It now reads the trigger-maintained per-target counter, so
  // `take` bounds the DATABASE's work and not just the wire.
  //
  // Each clause earns its place: `take` is the bound itself; the two-key
  // `orderBy` is what lets `compute_targets_queued_depth_idx` serve the whole
  // ORDER BY … LIMIT with no sort, which is what makes the bound a constant
  // rather than a slice of a sorted table; `gt: 0` keeps drained targets absent
  // so a drained target is absent rather than a zero-depth backlog; and the
  // sentinel predicate keeps a target that runs no executor from holding one of
  // the caller's deepest-backlog slots against a real desktop. Dropping any of
  // them leaves every value assertion below green.
  it("reads the per-target counter for non-sentinel targets that hold a backlog, deepest first and capped", async () => {
    await countQueuedCommandsByTarget(7);

    expect(mocks.targetFindMany).toHaveBeenCalledWith({
      where: { isCloudSentinel: false, queuedCommandCount: { gt: 0 } },
      select: { id: true, queuedCommandCount: true },
      orderBy: [{ queuedCommandCount: "desc" }, { id: "asc" }],
      take: 8,
    });
  });

  // The backlog read must not touch `desktop_commands` at all any more. Pinned
  // separately from the call shape above because a partial revert — keeping the
  // counter column but restoring the aggregate to "double-check" it — would
  // satisfy neither this nor the ticket, and would reinstate the unbounded scan
  // while every depth assertion stayed green. (The bounded reconciliation does
  // read that table, deliberately and by a different function.)
  it("does not read the command table to answer a fleet-wide depth", async () => {
    await countQueuedCommandsByTarget(7);

    expect(mocks.findMany).not.toHaveBeenCalled();
    expect(mocks.count).not.toHaveBeenCalled();
    expect(mocks.queryRaw).not.toHaveBeenCalled();
  });

  // Pinned on its own as well as inside the whole-call assertion above: the two
  // fleet-scoped reads must agree on what a fleet is, and a sentinel reaching
  // one but not the other is exactly the drift that put sentinel work on the
  // gauge.
  it("scopes both fleet reads to the same non-sentinel fleet", async () => {
    await countQueuedCommandsByTarget(7);
    await listQueueDepthSweepPage(7);

    expect(mocks.targetFindMany.mock.calls[0][0].where).toMatchObject({
      isCloudSentinel: false,
    });
    expect(mocks.targetFindMany.mock.calls[1][0].where).toMatchObject({
      isCloudSentinel: false,
    });
  });

  it("maps the counter column onto the caller's named count", async () => {
    mocks.targetFindMany.mockResolvedValue([
      { id: "target-a", queuedCommandCount: 43 },
    ]);

    await expect(countQueuedCommandsByTarget(7)).resolves.toEqual({
      backlogs: [{ computeTargetId: "target-a", queuedCount: 43 }],
      hasMore: false,
    });
  });

  // An exactly-full page is what a complete fleet of that size returns too, so
  // the probe row is the only thing that can tell the two apart. Reporting the
  // page as truncated on its length alone would mark a fully covered fleet
  // partial and present its backlog count as a floor it is not.
  it("reports a full page with nothing past it as complete", async () => {
    mocks.targetFindMany.mockResolvedValue([
      { id: "target-a", queuedCommandCount: 9 },
      { id: "target-b", queuedCommandCount: 4 },
    ]);

    await expect(countQueuedCommandsByTarget(2)).resolves.toEqual({
      backlogs: [
        { computeTargetId: "target-a", queuedCount: 9 },
        { computeTargetId: "target-b", queuedCount: 4 },
      ],
      hasMore: false,
    });
  });

  // Large cardinality. Since ISS-8674 the cap bounds the database's work too —
  // `compute_targets_queued_depth_idx` is walked for exactly `limit + 1`
  // entries — but this case pins the caller-facing half that a mocked client
  // can actually observe: an attacker-inflatable target count cannot grow the
  // emission, and the overflow is reported rather than swallowed. That the
  // database itself stops at the cap is pinned by the index DDL test in
  // `packages/database/__tests__/iss8674-queued-command-count-migration.test.ts`.
  it("returns at most the cap however many targets hold a backlog", async () => {
    mocks.targetFindMany.mockResolvedValue(
      Array.from({ length: 5000 }, (_, index) => ({
        id: `target-${index}`,
        queuedCommandCount: 5000 - index,
      }))
    );

    const page = await countQueuedCommandsByTarget(500);

    expect(page.backlogs).toHaveLength(500);
    expect(page.hasMore).toBe(true);
    // Deepest-first survives the slice, so the cap drops the shallow tail.
    expect(page.backlogs[0]).toEqual({
      computeTargetId: "target-0",
      queuedCount: 5000,
    });
  });

  // The probe row is read, never returned: publishing it would put one target
  // over the caller's budget on every capped tick.
  it("reports hasMore from the backlog probe row and does not return it", async () => {
    mocks.targetFindMany.mockResolvedValue([
      { id: "target-a", queuedCommandCount: 9 },
      { id: "target-b", queuedCommandCount: 4 },
      { id: "target-c", queuedCommandCount: 1 },
    ]);

    await expect(countQueuedCommandsByTarget(2)).resolves.toEqual({
      backlogs: [
        { computeTargetId: "target-a", queuedCount: 9 },
        { computeTargetId: "target-b", queuedCount: 4 },
      ],
      hasMore: true,
    });
  });

  // Ordering is the whole fix for permanent omission. Primary-key order is
  // STABLE, so a fleet past the cap lost the same tail on every tick forever;
  // least-recently-swept order makes the cap a deferral, because a target the
  // cap skipped keeps its old key and sorts ahead on the next tick. Reversing
  // this to `desc`, or back to `id`, reinstates that omission with every value
  // assertion below still green.
  it("reads the sweep page least-recently-swept first, non-sentinel, capped", async () => {
    await listQueueDepthSweepPage(7);

    expect(mocks.targetFindMany).toHaveBeenCalledWith({
      where: { isCloudSentinel: false },
      select: { id: true, queuedCommandCount: true },
      orderBy: [{ queuedDepthSweptAt: "asc" }, { id: "asc" }],
      take: 7,
    });
  });

  // The sweep carries each target's REAL depth. Before ISS-8674 it returned ids
  // alone and the caller filled in a zero for anything the backlog page had not
  // named — a false zero for any target whose backlog that page's own cap
  // dropped.
  it("returns a measured depth per target, not just an id", async () => {
    mocks.targetFindMany.mockResolvedValue([
      { id: "target-a", queuedCommandCount: 4 },
      { id: "target-b", queuedCommandCount: 0 },
    ]);

    await expect(listQueueDepthSweepPage(7)).resolves.toEqual([
      { computeTargetId: "target-a", queuedCount: 4 },
      { computeTargetId: "target-b", queuedCount: 0 },
    ]);
  });

  // No probe row, unlike the backlog read: this page's job is coverage, and
  // what lies past it is reported as a COUNT by `countTargetsAwaitingSweep`
  // rather than as a boolean, so a partial tick says how much it still owes.
  it("takes exactly the limit, with no probe row", async () => {
    await listQueueDepthSweepPage(500);

    expect(mocks.targetFindMany.mock.calls[0][0].take).toBe(500);
  });

  // The stamp is what advances the rotation; without it every tick re-serves
  // the same head and the sweep never progresses.
  //
  // RAW SQL, not `updateMany`, and that is load-bearing rather than cosmetic:
  // `ComputeTarget.updatedAt` is `@updatedAt`, which Prisma rewrites on every
  // `updateMany` whatever `data` names, and `listByOwner` /
  // `listAvailableForOrg` order the user's compute-target lists by
  // `updatedAt DESC`. Stamping 500 targets every five minutes through Prisma
  // would reshuffle that list from internal bookkeeping alone.
  it("stamps the rotation key by raw SQL, leaving updated_at alone", async () => {
    const sweptAt = new Date("2026-09-01T12:00:00.000Z");

    await markQueueDepthSwept(["target-a", "target-b"], sweptAt);

    expect(mocks.targetUpdateMany).not.toHaveBeenCalled();
    expect(mocks.executeRaw).toHaveBeenCalledTimes(1);
    const [strings, ...values] = mocks.executeRaw.mock.calls[0];
    const sql = strings.join("?");
    expect(sql).toContain('UPDATE "compute_targets"');
    expect(sql).toContain('SET "queued_depth_swept_at"');
    expect(sql).not.toContain("updated_at");
    expect(values).toContain(sweptAt);
    expect(values).toContainEqual(["target-a", "target-b"]);
  });

  // An empty page must not issue an unscoped updateMany, which would stamp the
  // WHOLE fleet and erase the rotation in one tick.
  it("writes nothing when no target was gauged", async () => {
    await expect(markQueueDepthSwept([], new Date())).resolves.toBe(0);

    expect(mocks.executeRaw).not.toHaveBeenCalled();
  });

  // The progress number behind "truthful completeness". `lt`, not `lte`: a
  // target stamped with this very cycle's instant has been gauged BY this tick
  // and does not still owe a sweep.
  it("counts the non-sentinel targets still owed a sweep this cycle", async () => {
    const cycleStart = new Date("2026-09-01T12:00:00.000Z");

    await countTargetsAwaitingSweep(cycleStart);

    expect(mocks.targetCount).toHaveBeenCalledWith({
      where: {
        isCloudSentinel: false,
        queuedDepthSweptAt: { lt: cycleStart },
      },
    });
  });

  // Reconciliation is scoped to the ids it is handed, and reads BOTH numbers in
  // ONE statement. Splitting them across two reads makes every command enqueued
  // between them look like drift; an unscoped version is the fleet-wide
  // aggregate this ticket removed, on a slower cadence.
  it("reads counter and real rows together, for the given ids only", async () => {
    await reconcileQueuedCounters(["target-a", "target-b"]);

    expect(mocks.queryRaw).toHaveBeenCalledTimes(1);
    const [strings, ...values] = mocks.queryRaw.mock.calls[0];
    const sql = strings.join("?");
    // One statement carrying both sides of the comparison.
    expect(sql).toContain('ct."queued_command_count"');
    expect(sql).toContain('count(dc."id")');
    // LEFT JOIN, so a target with no queued rows still returns a row with 0
    // rather than dropping out — the phantom-backlog case.
    expect(sql).toContain("LEFT JOIN");
    // Bound and status scope arrive as parameters, never interpolated.
    expect(values).toContain(DesktopCommandStatus.Queued);
    expect(values).toContainEqual(["target-a", "target-b"]);
  });

  it("maps the raw rows onto the reconciliation contract", async () => {
    mocks.queryRaw.mockResolvedValue([
      { computeTargetId: "target-a", counter: 5, actual: 3 },
    ]);

    await expect(reconcileQueuedCounters(["target-a"])).resolves.toEqual([
      { computeTargetId: "target-a", counter: 5, actualQueuedRows: 3 },
    ]);
  });

  it("issues no query for an empty reconciliation sample", async () => {
    await expect(reconcileQueuedCounters([])).resolves.toEqual([]);

    expect(mocks.queryRaw).not.toHaveBeenCalled();
  });
});

/**
 * whitlockk (PR #6459): the idle-drain suite mocks this helper entirely and this
 * query suite never called it, so deleting the `id IN (...)` predicate left
 * the whole test run green while turning this into a full `computeTarget`
 * table read every five minutes.
 */
describe("listComputeTargetLastSeen id-scoped read (ISS-8686)", () => {
  it("scopes the read to the given ids alone, selecting only id and lastSeenAt", async () => {
    mocks.targetFindMany.mockResolvedValue([
      { id: "target-a", lastSeenAt: new Date(1000) },
    ]);

    await listComputeTargetLastSeen(["target-a", "target-b"]);

    expect(mocks.targetFindMany).toHaveBeenCalledWith({
      where: { id: { in: ["target-a", "target-b"] } },
      select: { id: true, lastSeenAt: true },
    });
  });

  it("maps each returned target id to its lastSeenAt", async () => {
    const seenAt = new Date(1000);
    mocks.targetFindMany.mockResolvedValue([
      { id: "target-a", lastSeenAt: seenAt },
    ]);

    await expect(listComputeTargetLastSeen(["target-a"])).resolves.toEqual(
      new Map([["target-a", seenAt]])
    );
  });

  it("shortcuts an empty id list without querying the database", async () => {
    await expect(listComputeTargetLastSeen([])).resolves.toEqual(new Map());

    expect(mocks.targetFindMany).not.toHaveBeenCalled();
    expect(mocks.withDb).not.toHaveBeenCalled();
  });
});

/**
 * ISS-8740 review (whitlockk, marisolashgrove): the id list this write receives is NOT
 * bounded by the hello's queued cap. The hello slices it from a read whose
 * in-flight half is deliberately uncapped, so the list grows with the target's
 * accepted/running population — and nothing terminalizes a row stranded in
 * flight. Chunking bounds one `IN` predicate WITHOUT dropping an id, which a
 * cap here could not do: this write is what records a withheld row as in flight
 * nowhere, so a dropped id strands exactly what it exists to rescue.
 */
type RequeueWriteArgs = {
  where: {
    computeTargetId: string;
    id: { in: string[] };
    status: { in: string[] };
  };
  // `queuedAt` is optional in the TYPE only so a mutation that drops it fails on
  // the assertion below rather than on the compiler, which would report a
  // missing property instead of the behaviour that went missing.
  data: { status: string; queuedAt?: Date };
};

/** The `updateMany` payloads the requeue actually issued, in call order. */
function requeueWriteArgs(): RequeueWriteArgs[] {
  return mocks.updateMany.mock.calls.map((call) => call[0]);
}

function requeuedIdChunks(): string[][] {
  return requeueWriteArgs().map((args) => args.where.id.in);
}

describe("requeueUndeliveredCommands id-list bound", () => {
  const REQUEUED_IDS = Array.from(
    { length: 1201 },
    (_unused, index) => `command-${index}`
  );

  it("splits a long id list across writes and retains every id exactly once", async () => {
    await requeueUndeliveredCommands(TARGET_ID, REQUEUED_IDS);

    const chunks = requeuedIdChunks();
    expect(chunks.flat()).toEqual(REQUEUED_IDS);
    // Every chunk is strictly smaller than the whole list, so a single
    // unbounded `IN` fails here rather than only at the Postgres bind limit.
    expect(Math.max(...chunks.map((chunk) => chunk.length))).toBeLessThan(
      REQUEUED_IDS.length
    );
    expect(chunks.length).toBeGreaterThan(1);
  });

  it("sums the rows each chunk actually moved", async () => {
    mocks.updateMany
      .mockResolvedValueOnce({ count: 500 })
      .mockResolvedValueOnce({ count: 500 })
      .mockResolvedValueOnce({ count: 7 });

    await expect(
      requeueUndeliveredCommands(TARGET_ID, REQUEUED_IDS)
    ).resolves.toBe(1007);
  });

  it("scopes every chunk to the target and to in-flight rows only", async () => {
    await requeueUndeliveredCommands(TARGET_ID, REQUEUED_IDS);

    for (const args of requeueWriteArgs()) {
      expect(args.where.computeTargetId).toBe(TARGET_ID);
      expect(args.where.status).toEqual({
        in: IN_FLIGHT_DESKTOP_COMMAND_STATUSES,
      });
      expect(args.data.status).toBe(DesktopCommandStatus.Queued);
    }
  });

  // The requeue IS the row's new queue entry, and until it said so the
  // ack-timeout sweep banded on `created_at` — dispatch time, which a requeue
  // never touches. A command that reached `accepted` (only an ack does that)
  // and was then requeued got reported `timed_out`, a confidently wrong value
  // on the exact axis ISS-7223 exists to name.
  it("stamps the new queue entry so a requeued row is not read as never acked", async () => {
    await requeueUndeliveredCommands(TARGET_ID, REQUEUED_IDS);

    for (const args of requeueWriteArgs()) {
      expect(args.data.queuedAt).toBeInstanceOf(Date);
    }
  });

  it("leaves createdAt alone, which still answers when the command was dispatched", async () => {
    await requeueUndeliveredCommands(TARGET_ID, REQUEUED_IDS);

    for (const args of requeueWriteArgs()) {
      expect(args.data).not.toHaveProperty("createdAt");
    }
  });

  it("stamps one instant across every chunk, so a long requeue does not fan a row's queue entry", async () => {
    await requeueUndeliveredCommands(TARGET_ID, REQUEUED_IDS);

    const stamps = requeueWriteArgs().map((args) =>
      args.data.queuedAt?.getTime()
    );
    expect(stamps.every((stamp) => stamp !== undefined)).toBe(true);
    expect(stamps.length).toBeGreaterThan(1);
    expect(new Set(stamps).size).toBe(1);
  });

  it("writes nothing for an empty id list", async () => {
    await expect(requeueUndeliveredCommands(TARGET_ID, [])).resolves.toBe(0);
    expect(mocks.updateMany).not.toHaveBeenCalled();
  });
});

/**
 * ISS-7223. These pin the QUERY, which the sweep's own suite cannot: that suite
 * mocks this whole module, so a swapped `gt`/`gte`, an inverted truncation
 * check, or a dropped predicate leaves every one of its cases green.
 *
 * The band bounds are written as plain arithmetic on the input rather than
 * re-derived from the production constants, so a change to the constants cannot
 * move the expectation with the code.
 */
describe("ack-deadline crossings (ISS-7223)", () => {
  const NOW = new Date("2026-08-19T12:00:00.000Z");
  const TEN_MINUTES = 10 * 60 * 1000;
  const FIFTEEN_MINUTES = 15 * 60 * 1000;

  const crossingRow = (id: string, offsetMs = 0) => ({
    id,
    computeTargetId: TARGET_ID,
    queuedAt: new Date(NOW.getTime() - TEN_MINUTES + offsetMs),
    // ISS-9630: the column the read now projects. `null` is the ordinary case
    // — a crossing whose target never answered any delivery.
    ackedAt: null,
  });

  const readBand = (after?: { queuedAt: Date; id: string }) =>
    listCommandsCrossingAckDeadline({
      now: NOW,
      olderThanMs: TEN_MINUTES,
      youngerThanMs: FIFTEEN_MINUTES,
      limit: 2,
      ...(after ? { after } : {}),
    });

  it("selects a half-open band: exclusive at the young edge, inclusive at the old", async () => {
    await readBand();

    // `gt` at the far edge is what stops the previous tick's band being re-read;
    // `lte` at the near edge is what makes a command exactly at the deadline
    // belong to this tick rather than falling between two.
    expect(mocks.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          status: DesktopCommandStatus.Queued,
          queuedAt: {
            gt: new Date(NOW.getTime() - FIFTEEN_MINUTES),
            lte: new Date(NOW.getTime() - TEN_MINUTES),
          },
        }),
      })
    );
  });

  it("excludes cloud sentinels, which can never ack a queued row", async () => {
    await readBand();

    const args = mocks.findMany.mock.calls[0]?.[0] as {
      where: { computeTarget?: { isCloudSentinel?: boolean } };
    };
    expect(args.where.computeTarget).toEqual({ isCloudSentinel: false });
  });

  it("reads one row past the cap so a full page is distinguishable from a full band", async () => {
    mocks.findMany.mockResolvedValue([
      crossingRow("a"),
      crossingRow("b"),
      crossingRow("c"),
    ]);

    const page = await readBand();

    const firstCall = mocks.findMany.mock.calls[0];
    if (!firstCall) {
      throw new Error("findMany was never called");
    }
    expect((firstCall[0] as { take: number }).take).toBe(3);
    expect(page.commands.map((command) => command.commandId)).toEqual([
      "a",
      "b",
    ]);
    // A RESUME POINT, not a truncation flag: the caller pages from here, so a
    // crossing past the page is deferred rather than dropped. The band's far
    // edge has moved by the next tick, so a dropped one is lost for good.
    expect(page.cursor).toEqual({
      queuedAt: new Date(NOW.getTime() - TEN_MINUTES),
      id: "b",
    });
  });

  it("reports a page at exactly the cap as complete, not truncated", async () => {
    // The positive sibling of the case above: the cursor must distinguish the
    // two, or a floor gets reported as the whole band and vice versa.
    mocks.findMany.mockResolvedValue([crossingRow("a"), crossingRow("b")]);

    const page = await readBand();

    expect(page.commands).toHaveLength(2);
    expect(page.cursor).toBeUndefined();
  });

  // Keyset, not OFFSET: resuming must seek along
  // `desktop_commands_queued_at_idx` rather than re-read and discard every row
  // already reported, and it must stay inside the band.
  it("resumes strictly after the cursor without leaving the band", async () => {
    const after = { queuedAt: new Date(NOW.getTime() - TEN_MINUTES), id: "b" };

    await readBand(after);

    const args = mocks.findMany.mock.calls[0]?.[0] as {
      where: { OR?: unknown[] };
      skip?: number;
    };
    expect(args.where.OR).toEqual([
      {
        queuedAt: {
          gt: after.queuedAt,
          lte: new Date(NOW.getTime() - TEN_MINUTES),
        },
      },
      { queuedAt: after.queuedAt, id: { gt: "b" } },
    ]);
    expect(args.skip).toBeUndefined();
  });

  // `created_at` is dispatch time and the requeue does not move it, so banding
  // on it reported an already-acked command as timed out AND never looked at a
  // requeued command whose redelivery genuinely went unacked.
  it("bands and orders on the queue entry, never on dispatch time", async () => {
    await readBand();

    const args = mocks.findMany.mock.calls[0]?.[0] as {
      where: Record<string, unknown>;
      orderBy: unknown;
      select: Record<string, unknown>;
    };
    expect(args.where).not.toHaveProperty("createdAt");
    expect(args.orderBy).toEqual([{ queuedAt: "asc" }, { id: "asc" }]);
    expect(args.select).toMatchObject({ queuedAt: true });
  });

  it("carries the recorded ack time through to the crossing (ISS-9630)", async () => {
    // The projection and the mapping are two separate lines, and without this
    // case dropping EITHER stayed green: `row.ackedAt` would come back
    // `undefined`, and `undefined !== null` is true, so the caller's predicate
    // would call `.getTime()` on it and throw — taking down every crossing
    // report for the tick rather than mis-reporting one command.
    const ackedAt = new Date(NOW.getTime() - TEN_MINUTES - 60_000);
    mocks.findMany.mockResolvedValue([
      { ...crossingRow("cmd-acked"), ackedAt },
    ]);

    const page = await readBand();

    expect(page.commands[0]?.ackedAt).toEqual(ackedAt);
    const args = mocks.findMany.mock.calls[0]?.[0] as {
      select: Record<string, unknown>;
    };
    // The WHOLE select, not a subset: `toMatchObject` ignores extra keys, so it
    // cannot notice a projected column going missing.
    expect(args.select).toEqual({
      id: true,
      computeTargetId: true,
      queuedAt: true,
      ackedAt: true,
    });
  });

  it("reads nothing for a non-positive limit or an inverted band", async () => {
    await expect(
      listCommandsCrossingAckDeadline({
        now: NOW,
        olderThanMs: TEN_MINUTES,
        youngerThanMs: FIFTEEN_MINUTES,
        limit: 0,
      })
    ).resolves.toEqual({ commands: [], cursor: undefined });
    await expect(
      listCommandsCrossingAckDeadline({
        now: NOW,
        olderThanMs: FIFTEEN_MINUTES,
        youngerThanMs: TEN_MINUTES,
        limit: 2,
      })
    ).resolves.toEqual({ commands: [], cursor: undefined });

    expect(mocks.findMany).not.toHaveBeenCalled();
  });

  it("keeps the canonical JSON path filter on the grouped in-flight count", async () => {
    // Same reason the per-target count keeps it: without it the legacy rows a
    // reconnect strands `accepted` are counted as in-flight work that nothing
    // terminalizes, and the consumer folds `> 0` to `target_busy` — so one
    // phantom row would bucket every later lost ack on that target as ordinary
    // queueing.
    await countInFlightCommandsByTarget([TARGET_ID]);

    expect(mocks.groupBy).toHaveBeenCalledWith({
      by: ["computeTargetId"],
      where: {
        computeTargetId: { in: [TARGET_ID] },
        requestPayload: GATEWAY_PATH_FILTER,
        status: { in: IN_FLIGHT_DESKTOP_COMMAND_STATUSES },
      },
      _count: { _all: true },
    });
  });

  it("maps grouped counts by target and queries nothing for an empty id list", async () => {
    mocks.groupBy.mockResolvedValue([
      { computeTargetId: TARGET_ID, _count: { _all: 3 } },
    ]);

    await expect(countInFlightCommandsByTarget([TARGET_ID])).resolves.toEqual(
      new Map([[TARGET_ID, 3]])
    );

    mocks.groupBy.mockClear();
    await expect(countInFlightCommandsByTarget([])).resolves.toEqual(new Map());
    expect(mocks.groupBy).not.toHaveBeenCalled();
  });
});

describe("listIdleDrainCandidates page shape (ISS-8895)", () => {
  const PRESENT_SINCE = new Date("2026-09-11T12:00:00.000Z");

  // ISS-8895 finding 1 (whitlockk, PR #6459). ONE call carrying both the presence
  // predicate and the cap is the fix: the old shape took the deepest 100
  // backlogs first and discarded the presence-covered ones afterwards in JS, so
  // a fleet of connected desktops could fill every slot with rows the drain was
  // about to refuse. Asserting the whole call rather than a subset is what
  // makes dropping the depth or sentinel predicate fail here too.
  it("asks for the cap and the presence filter in one bounded read", async () => {
    await listIdleDrainCandidates(100, PRESENT_SINCE);

    expect(mocks.targetFindMany).toHaveBeenCalledWith({
      where: {
        isCloudSentinel: false,
        queuedCommandCount: { gt: 0 },
        OR: [{ presenceAt: null }, { presenceAt: { lte: PRESENT_SINCE } }],
      },
      select: { id: true, presenceAt: true, createdAt: true },
      orderBy: [{ queuedCommandCount: "desc" }, { id: "asc" }],
      take: 101,
    });
  });

  // ISS-8895 finding 2 was delivered by ISS-8674 (#6414), which moved the
  // fleet-wide depth off a `desktop_commands` group-by and onto the
  // trigger-maintained counter column. This read inherits that, and the
  // assertion is here so a revert that reintroduced the aggregate to
  // "double-check" the counter would fail rather than quietly restore the
  // unbounded scan the finding asked to bound.
  it("answers from the counter column without touching the command table", async () => {
    await listIdleDrainCandidates(100, PRESENT_SINCE);

    expect(mocks.groupBy).not.toHaveBeenCalled();
    expect(mocks.findMany).not.toHaveBeenCalled();
    expect(mocks.count).not.toHaveBeenCalled();
  });

  it("carries the clock the caller needs for a target that has never been present", async () => {
    const createdAt = new Date("2026-09-01T00:00:00.000Z");
    mocks.targetFindMany.mockResolvedValue([
      { id: "target-a", presenceAt: null, createdAt },
    ]);

    await expect(listIdleDrainCandidates(100, PRESENT_SINCE)).resolves.toEqual({
      candidates: [
        { computeTargetId: "target-a", presenceAt: null, createdAt },
      ],
      hasMore: false,
    });
  });

  // The probe row is read, never returned: publishing it would put one target
  // over the caller's per-tick budget on every capped tick.
  it("reports hasMore from the probe row and does not return it", async () => {
    const createdAt = new Date("2026-09-01T00:00:00.000Z");
    mocks.targetFindMany.mockResolvedValue([
      { id: "target-a", presenceAt: null, createdAt },
      { id: "target-b", presenceAt: null, createdAt },
      { id: "target-c", presenceAt: null, createdAt },
    ]);

    const page = await listIdleDrainCandidates(2, PRESENT_SINCE);

    expect(page.candidates.map((row) => row.computeTargetId)).toEqual([
      "target-a",
      "target-b",
    ]);
    expect(page.hasMore).toBe(true);
  });
});

describe("drain lease statement shape (ISS-8896)", () => {
  // The lease's guarantee is a Postgres one and is exercised against a real
  // database in `__tests__/integration/idle-drain-concurrency.integration.test.ts`.
  // What a mocked client CAN prove is the half that would silently break it:
  // a claim is one conditional UPDATE, and anything but exactly one returned
  // row is a refusal. A `length > 0` reading would let a predicate that matched
  // two rows report success for both callers.
  const LEASE_TARGET_ID = "018f0000-0000-7000-8000-000000000000";
  const LEASE_TTL_MS = 15_000;

  it("treats anything but a single claimed row as a refusal", async () => {
    mocks.queryRaw.mockResolvedValue([]);

    await expect(
      acquireCommandDrainLease(LEASE_TARGET_ID, LEASE_TTL_MS)
    ).resolves.toBeNull();
    expect(mocks.queryRaw).toHaveBeenCalledTimes(1);
  });

  it("returns the written expiry when exactly one row was taken", async () => {
    // The expiry comes BACK from the statement rather than being echoed from an
    // argument: it is the database's clock that decides when the window starts,
    // so a caller that assumed its own `now + ttl` would be wrong by however
    // long the statement waited for a pooled connection (whitlockk, PR #7119).
    const written = new Date("2026-09-11T00:00:15.000Z");
    mocks.queryRaw.mockResolvedValue([{ leaseUntil: written }]);

    await expect(
      acquireCommandDrainLease(LEASE_TARGET_ID, LEASE_TTL_MS)
    ).resolves.toEqual(written);
  });

  it("reports a renewal the target has moved on from as a refusal", async () => {
    mocks.queryRaw.mockResolvedValue([]);

    await expect(
      renewCommandDrainLease(LEASE_TARGET_ID, new Date(1000), LEASE_TTL_MS)
    ).resolves.toBeNull();
  });

  it("returns the extended expiry when the renewal still owns the target", async () => {
    const extended = new Date("2026-09-11T00:00:45.000Z");
    mocks.queryRaw.mockResolvedValue([{ leaseUntil: extended }]);

    await expect(
      renewCommandDrainLease(LEASE_TARGET_ID, new Date(1000), LEASE_TTL_MS)
    ).resolves.toEqual(extended);
  });
});
