import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * ISS-8740: `listNonTerminalDispatchCommands` had no `take`, so a hello
 * materialized a target's whole non-terminal backlog inside a 5s stage timeout.
 * Blowing that timeout nacks the handshake, which disconnects the target that
 * would have drained the queue, which deepens it.
 *
 * The bound is split by status, and these cases pin BOTH halves: the queued page
 * is capped, and the `accepted`/`running` page is deliberately NOT, because a
 * dropped in-flight row is stranded permanently.
 *
 * The fake Prisma below honours `where.status`, `orderBy`, and `take`, and every
 * seeded row carries a distinct `createdAt` and id — so deleting the cap, the
 * status split, or the ordering each changes what a case observes.
 */

const mocks = vi.hoisted(() => ({
  withDb: vi.fn(),
  findMany: vi.fn(),
  warn: vi.fn(),
}));

vi.mock("@repo/database", () => ({ withDb: mocks.withDb }));

vi.mock("@repo/observability/log", () => ({
  log: { error: vi.fn(), warn: mocks.warn, info: vi.fn(), debug: vi.fn() },
}));

import { DesktopCommandStatus } from "@repo/api/src/types/compute-target";
import { IN_FLIGHT_DESKTOP_COMMAND_STATUSES } from "@/lib/desktop-command-mappers";
import { desktopCommandStore } from "@/lib/desktop-command-store";
import {
  HELLO_QUEUED_CAPPED_LOG_EVENT,
  HELLO_QUEUED_COMMAND_LIMIT,
} from "@/lib/desktop-gateway-reconnect";

const TARGET_ID = "019cfdce-59c0-726e-93e8-5c33aadcae6c";
const EPOCH = Date.parse("2026-09-01T00:00:00.000Z");

type Row = {
  id: string;
  computeTargetId: string;
  operationId: string;
  status: string;
  requestPayload: { operationId: string; method: string; path: string };
  error: null;
  createdAt: Date;
  startedAt: null;
  finishedAt: null;
  lastSequenceAcked: number;
  idempotencyKey: null;
  requestFingerprint: string;
};

/** `ageRank` drives `createdAt`, so oldest-first ordering is observable. */
function row(id: string, status: string, ageRank: number): Row {
  return {
    id,
    computeTargetId: TARGET_ID,
    operationId: `operation-${id}`,
    status,
    requestPayload: {
      operationId: `operation-${id}`,
      method: "POST",
      path: "/api/gateway/exec",
    },
    error: null,
    createdAt: new Date(EPOCH + ageRank * 1000),
    startedAt: null,
    finishedAt: null,
    lastSequenceAcked: 0,
    idempotencyKey: null,
    requestFingerprint: `fingerprint-${id}`,
  };
}

function queuedRows(count: number, startRank: number): Row[] {
  return Array.from({ length: count }, (_unused, index) =>
    row(`queued-${index}`, DesktopCommandStatus.Queued, startRank + index)
  );
}

type StatusFilter = string | { in: string[] } | { notIn: string[] };

type FindManyArgs = {
  where: { status: StatusFilter };
  take?: number;
};

/** Records each call's args so per-status assertions can name which read. */
const calls: FindManyArgs[] = [];

function matchesStatus(filter: StatusFilter, status: string): boolean {
  if (typeof filter === "string") {
    return filter === status;
  }
  if ("in" in filter) {
    return filter.in.includes(status);
  }
  return !filter.notIn.includes(status);
}

function argsForStatus(status: string): FindManyArgs | undefined {
  return calls.find((call) => matchesStatus(call.where.status, status));
}

/**
 * Seeds a table behind a `findMany` that filters on `where.status`, sorts
 * oldest-first, and applies `take` the way Postgres applies `LIMIT` — so an
 * unbounded read returns everything, exactly as it did in production.
 */
function seed(rows: Row[]): void {
  mocks.findMany.mockImplementation((args: FindManyArgs): Row[] => {
    calls.push(args);
    const matched = rows
      .filter((candidate) => matchesStatus(args.where.status, candidate.status))
      .sort(
        (left, right) =>
          left.createdAt.getTime() - right.createdAt.getTime() ||
          left.id.localeCompare(right.id)
      );
    return args.take === undefined ? matched : matched.slice(0, args.take);
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  calls.length = 0;
  mocks.withDb.mockImplementation((fn: (db: unknown) => unknown) =>
    fn({ desktopCommand: { findMany: mocks.findMany } })
  );
});

describe("listNonTerminalDispatchCommands backlog bound", () => {
  it("caps the queued read in SQL, reading one row past the limit as the probe", async () => {
    seed(queuedRows(HELLO_QUEUED_COMMAND_LIMIT * 4, 100));

    await desktopCommandStore.listNonTerminalDispatchCommands(TARGET_ID);

    expect(argsForStatus(DesktopCommandStatus.Queued)?.take).toBe(
      HELLO_QUEUED_COMMAND_LIMIT + 1
    );
  });

  it("leaves the in-flight read uncapped, because a dropped in-flight row is stranded", async () => {
    seed(queuedRows(HELLO_QUEUED_COMMAND_LIMIT * 4, 100));

    await desktopCommandStore.listNonTerminalDispatchCommands(TARGET_ID);

    expect(argsForStatus(DesktopCommandStatus.Accepted)?.take).toBeUndefined();
  });

  it("returns exactly the limit of queued rows when the backlog runs deeper", async () => {
    seed(queuedRows(HELLO_QUEUED_COMMAND_LIMIT * 4, 100));

    const commands =
      await desktopCommandStore.listNonTerminalDispatchCommands(TARGET_ID);

    expect(commands).toHaveLength(HELLO_QUEUED_COMMAND_LIMIT);
  });

  it("names the target when the cap binds, so truncation is not silent", async () => {
    seed(queuedRows(HELLO_QUEUED_COMMAND_LIMIT * 4, 100));

    await desktopCommandStore.listNonTerminalDispatchCommands(TARGET_ID);

    expect(mocks.warn).toHaveBeenCalledWith(HELLO_QUEUED_CAPPED_LOG_EVENT, {
      computeTargetId: TARGET_ID,
      limit: HELLO_QUEUED_COMMAND_LIMIT,
    });
  });

  /**
   * The probe row and the cap meet only at LIMIT + 1, so `take: LIMIT` or a `<`
   * in place of `<=` is invisible at every other depth.
   */
  it("binds at exactly one row past the limit", async () => {
    seed(queuedRows(HELLO_QUEUED_COMMAND_LIMIT + 1, 100));

    const commands =
      await desktopCommandStore.listNonTerminalDispatchCommands(TARGET_ID);

    expect(commands).toHaveLength(HELLO_QUEUED_COMMAND_LIMIT);
    expect(mocks.warn).toHaveBeenCalledWith(
      HELLO_QUEUED_CAPPED_LOG_EVENT,
      expect.anything()
    );
  });

  it("returns a backlog that exactly fills the cap whole, and does not warn", async () => {
    seed(queuedRows(HELLO_QUEUED_COMMAND_LIMIT, 100));

    const commands =
      await desktopCommandStore.listNonTerminalDispatchCommands(TARGET_ID);

    // An exactly-full page is not a truncated one — warning here would report a
    // completely covered read as partial.
    expect(commands).toHaveLength(HELLO_QUEUED_COMMAND_LIMIT);
    expect(mocks.warn).not.toHaveBeenCalledWith(
      HELLO_QUEUED_CAPPED_LOG_EVENT,
      expect.anything()
    );
  });

  /**
   * ISS-8740, the regression this split exists to prevent.
   *
   * `POST /compute-targets/[id]/commands` dispatches on arrival with no capacity
   * gate, so a freshly `accepted` row carries the NEWEST `createdAt` and sorts
   * BEHIND a deep queued backlog. A single `createdAt asc` cap over all
   * non-terminal rows drops it: never re-emitted, and never requeued, because
   * the reconnect requeue builds its id list from this result. Nothing
   * terminalizes it afterwards, so it understates that target's `free` forever.
   */
  it("returns an in-flight row newer than the whole queued backlog", async () => {
    const newestInFlight = row(
      "accepted-newest",
      DesktopCommandStatus.Accepted,
      99_999
    );
    seed([...queuedRows(HELLO_QUEUED_COMMAND_LIMIT * 4, 100), newestInFlight]);

    const commands =
      await desktopCommandStore.listNonTerminalDispatchCommands(TARGET_ID);

    expect(commands.map((command) => command.commandId)).toContain(
      "accepted-newest"
    );
  });

  it("orders the merged result oldest-first across both reads", async () => {
    seed([
      row("queued-old", DesktopCommandStatus.Queued, 1),
      row("accepted-mid", DesktopCommandStatus.Accepted, 2),
      row("queued-new", DesktopCommandStatus.Queued, 3),
    ]);

    const commands =
      await desktopCommandStore.listNonTerminalDispatchCommands(TARGET_ID);

    expect(commands.map((command) => command.commandId)).toEqual([
      "queued-old",
      "accepted-mid",
      "queued-new",
    ]);
  });

  /**
   * ISS-8740 AC4, QUEUED HALF ONLY. The relay hello builds
   * `requeueUndeliveredCommands`' `id: IN` list by slicing this return, so the
   * queued contribution to that list inherits this cap however deep the queue
   * gets. It does NOT bound the list: the in-flight half of this read is
   * deliberately uncapped, so the id list is bounded by the target's
   * accepted/running count. The seed here is queued-only and pins only the
   * queued contribution; the write-side bound is `requeueUndeliveredCommands`'
   * own chunking, covered in `desktop-command-dispatch-queries.test.ts`.
   */
  it("bounds the queued rows handed to the reconnect requeue, however deep the queue", async () => {
    seed(queuedRows(20_000, 100));

    const commands =
      await desktopCommandStore.listNonTerminalDispatchCommands(TARGET_ID);

    expect(commands.length).toBeLessThanOrEqual(HELLO_QUEUED_COMMAND_LIMIT);
  });
  /**
   * The two reads take two snapshots however they are issued, so a row whose
   * status changes between them lands in both pages or in neither — and the
   * ORDER decides which. This drives the transition a concurrent
   * `dispatchQueuedCommand` writes (`queued -> accepted`) into that window.
   *
   * Queued-first makes it a duplicate, which the merge collapses by id, so the
   * row survives exactly once. In-flight-first makes it a MISS: absent from both
   * pages, so it is neither emitted nor withheld, `requeueUndeliveredCommands`
   * never sees it, and it sits `accepted` on no desktop counting against `free`.
   *
   * One case, two mutations: reverse the read order and the array is empty;
   * drop the id de-duplication and it carries the row twice.
   */
  it("keeps a row a concurrent dispatch flips queued -> accepted between the two reads, exactly once", async () => {
    const racing = row("racing", DesktopCommandStatus.Queued, 5);
    let reads = 0;
    mocks.findMany.mockImplementation((args: FindManyArgs): Row[] => {
      calls.push(args);
      const matched = [racing].filter((candidate) =>
        matchesStatus(args.where.status, candidate.status)
      );
      reads += 1;
      if (reads === 1) {
        // The dispatch lands between the two reads.
        racing.status = DesktopCommandStatus.Accepted;
      }
      return matched;
    });

    const commands =
      await desktopCommandStore.listNonTerminalDispatchCommands(TARGET_ID);

    expect(commands.map((command) => command.commandId)).toEqual(["racing"]);
  });

  /**
   * The in-flight page selects a set DERIVED from the exhaustive
   * `COMMAND_STATUS_IS_TERMINAL` record rather than a literal `[accepted,
   * running]` pair, so a fourth non-terminal status is enrolled automatically
   * instead of silently dropping out of every hello.
   *
   * HONEST LIMIT: today the derived set and the literal pair are the same two
   * values, so this case passes against either spelling. It pins that the read
   * asks for the derived set, not that the derivation is exhaustive — that
   * guarantee is `tsc` on the record, plus the partition case in
   * `desktop-command-mappers.test.ts`.
   */
  it("selects the in-flight page by the derived status set", async () => {
    seed(queuedRows(2, 100));

    await desktopCommandStore.listNonTerminalDispatchCommands(TARGET_ID);

    expect(argsForStatus(DesktopCommandStatus.Accepted)?.where.status).toEqual({
      in: IN_FLIGHT_DESKTOP_COMMAND_STATUSES,
    });
  });
});
