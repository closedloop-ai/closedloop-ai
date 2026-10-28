/**
 * ISS-9630: `acknowledgeCommand` records that the target ANSWERED, on every
 * branch that reaches the write.
 *
 * The branch that matters most is the one that previously wrote nothing. An ack
 * for a command that had already raced ahead to `running` produced an EMPTY
 * update, so the answer left no trace on the row — and a requeue would then
 * return it to `queued` looking exactly like a command the target never
 * received. A retry policy reading that row would re-dispatch work that had
 * already run, which is the whole hazard the column exists to make visible.
 *
 * The expected timestamps are written out here as literals, never read back
 * from the value the store produced, so an implementation that stamped the
 * wrong field or skipped a branch cannot agree with its own fixture. Each case
 * asserts the WHOLE `data` object rather than one key, so a stray write is a
 * failure too.
 *
 * Note which instant each assertion expects. The ack stamp is the QUEUE ATTEMPT
 * being answered (`QUEUED_AT`), not the wall clock at which the ack was
 * processed (`ACK_AT`) — the two are deliberately an hour apart here so a
 * regression to `new Date()` fails rather than coincides. Why that binding is
 * the fix for the reconnect race is the last describe in this file.
 */
import { DesktopCommandStatus } from "@repo/api/src/types/compute-target";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  withDb: vi.fn(),
  withDbTx: vi.fn(),
  findCommandByIdScoped: vi.fn(),
}));

vi.mock("@repo/database", () => ({
  // `ingestCommandEvent` writes through `withDb.tx`, not `withDb`.
  withDb: Object.assign(mocks.withDb, { tx: mocks.withDbTx }),
}));

vi.mock("@repo/observability/log", () => ({
  log: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

// Only `findCommandByIdScoped` is reached by `acknowledgeCommand`; the rest are
// named so the module's import list still resolves.
vi.mock("@/lib/desktop-command-lookup", () => ({
  clearIdempotencyCache: vi.fn(),
  findCommandById: vi.fn(),
  findCommandByIdScoped: mocks.findCommandByIdScoped,
  IdempotencyConflictError: class extends Error {},
  recoverDuplicateCommand: vi.fn(),
  rememberIdempotentCommand: vi.fn(),
  resolveIdempotentCommand: vi.fn(),
}));

import { wasAnsweredOnEarlierDelivery } from "@/lib/desktop-command-ack-timeout";
import { desktopCommandStore } from "@/lib/desktop-command-store";

const COMMAND_ID = "11111111-1111-4111-8111-111111111111";
const TARGET_ID = "22222222-2222-4222-8222-222222222222";
/** The frozen wall clock: when the ack is PROCESSED. */
const ACK_AT = new Date("2026-09-11T12:00:00.000Z");
/** The queue entry the ack answers, and so the instant it must stamp. */
const QUEUED_AT = new Date("2026-09-11T11:00:00.000Z");

function storedRow(status: string) {
  return {
    id: COMMAND_ID,
    computeTargetId: TARGET_ID,
    idempotencyKey: null,
    requestFingerprint: "fingerprint",
    operationId: "operation-1",
    requestPayload: { method: "GET", path: "/api/gateway/health" },
    status,
    error: null,
    lastSequenceAcked: 0,
    queuedTimeoutMs: null,
    runningTimeoutMs: null,
    createdAt: QUEUED_AT,
    queuedAt: QUEUED_AT,
    ackedAt: null,
    startedAt: null,
    finishedAt: null,
  };
}

type CapturedUpdate = {
  data?: Record<string, unknown>;
  where?: Record<string, unknown>;
};

/** The `data` and `where` objects the store handed to `updateMany`. */
function captureUpdate(status: string): CapturedUpdate {
  const captured: CapturedUpdate = {};
  mocks.findCommandByIdScoped.mockResolvedValue(storedRow(status));
  mocks.withDb.mockImplementation((callback: (client: unknown) => unknown) =>
    callback({
      desktopCommand: {
        updateMany: (args: {
          data: Record<string, unknown>;
          where: Record<string, unknown>;
        }) => {
          captured.data = args.data;
          captured.where = args.where;
          return { count: 1 };
        },
      },
    })
  );
  return captured;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  vi.setSystemTime(ACK_AT);
});

// Unconditional, not the last line of a case: an assertion that throws midway
// would otherwise leak a frozen clock into every later test in this worker.
afterEach(() => {
  vi.useRealTimers();
});

describe("acknowledgeCommand records when the target answered", () => {
  it("stamps the answer for a command that had already reached running", async () => {
    // The branch that used to write nothing. `status` is deliberately absent
    // from the expected object: this ack must not regress a running command,
    // and the ONLY thing it may write is the answer time.
    const captured = captureUpdate(DesktopCommandStatus.Running);

    await desktopCommandStore.acknowledgeCommand(
      COMMAND_ID,
      true,
      undefined,
      TARGET_ID
    );

    expect(captured.data).toEqual({ ackedAt: QUEUED_AT });
  });

  it("stamps the answer alongside the accepted transition for a queued command", async () => {
    const captured = captureUpdate(DesktopCommandStatus.Queued);

    await desktopCommandStore.acknowledgeCommand(
      COMMAND_ID,
      true,
      undefined,
      TARGET_ID
    );

    expect(captured.data).toEqual({
      status: DesktopCommandStatus.Accepted,
      ackedAt: QUEUED_AT,
    });
  });

  it("stamps the answer for a rejection, which is also an answer", async () => {
    // A refusal tells us the target received the command and declined it. That
    // is a delivery the target took, so it must not read back as unanswered.
    const captured = captureUpdate(DesktopCommandStatus.Queued);

    await desktopCommandStore.acknowledgeCommand(
      COMMAND_ID,
      false,
      "busy",
      TARGET_ID
    );

    // `finishedAt` is the wall clock and `ackedAt` is the queue entry: the
    // command finished when the rejection was processed, but it answered the
    // delivery it was sent on. Asserting two DIFFERENT instants is what pins
    // that they are two different facts.
    expect(captured.data).toEqual({
      status: DesktopCommandStatus.Failed,
      error: "busy",
      finishedAt: ACK_AT,
      ackedAt: QUEUED_AT,
    });
  });
});

describe("ingestCommandEvent records the target's answer", () => {
  it("stamps the answer when a streamed event moves a queued command to running", async () => {
    // `acknowledgeCommand` is NOT the only way a command leaves `queued`.
    // `resolveCommandUpdate`'s queued/accepted arm promotes it to `running` on
    // a streamed event with no accept RPC at all, and `requeueUndeliveredCommands`
    // returns exactly those in-flight rows to `queued` on reconnect. If this
    // write stayed silent, a command the target had demonstrably taken would
    // read back as never-answered, and a retry would re-run it — the precise
    // false negative this column exists to prevent.
    const captured: { data?: Record<string, unknown> } = {};
    mocks.withDbTx.mockImplementation((callback: (tx: unknown) => unknown) =>
      callback({
        desktopCommand: {
          findUnique: () => storedRow(DesktopCommandStatus.Queued),
          update: (args: { data: Record<string, unknown> }) => {
            captured.data = args.data;
            return { id: COMMAND_ID };
          },
        },
        desktopCommandEvent: {
          create: () => ({ createdAt: ACK_AT }),
        },
      })
    );

    await desktopCommandStore.ingestCommandEvent({
      commandId: COMMAND_ID,
      eventType: "chunk",
      data: {},
      sequence: 1,
    });

    expect(captured.data?.ackedAt).toEqual(QUEUED_AT);
    // The transition itself is still pinned, so a change that stamped the
    // answer but stopped promoting the command would not pass here either.
    expect(captured.data?.status).toBe(DesktopCommandStatus.Running);
  });
});

/**
 * The reconnect race whitlockk raised on #7012, which is what forced the stamp off
 * the wall clock.
 *
 * `acknowledgeCommand` reads the row, then writes. `requeueUndeliveredCommands`
 * can commit between those two steps: an ack that read `running` lands after
 * the reconnect has returned the row to `queued` with a fresh `queuedAt`. A
 * wall-clock stamp taken on this side of that reset is at or after the NEW
 * entry, so the row reads `ackedAt >= queuedAt` and the sweep reports work the
 * target had already taken as never answered — the exact signal the column
 * exists to carry, lost in the case it was built for.
 */
describe("acknowledgeCommand survives a requeue racing the ack", () => {
  /** The entry `requeueUndeliveredCommands` writes while the ack is in flight. */
  const REQUEUED_AT = new Date(QUEUED_AT.getTime() + 30 * 60 * 1000);

  it("stamps the delivery it answered, so a requeue under it still reads as earlier", async () => {
    const captured = captureUpdate(DesktopCommandStatus.Running);

    await desktopCommandStore.acknowledgeCommand(
      COMMAND_ID,
      true,
      undefined,
      TARGET_ID
    );

    // The row the sweep would then read: the stamp this write produced, beside
    // the entry the requeue installed. `REQUEUED_AT` is a literal and the stamp
    // is whatever the store actually wrote, so nothing here is derived from the
    // predicate under test.
    const ackedAt = captured.data?.ackedAt as Date;
    expect(
      wasAnsweredOnEarlierDelivery({ ackedAt, queuedAt: REQUEUED_AT }),
      "a command the target demonstrably took must not read as never answered"
    ).toBe(true);
  });

  it("refuses to move a record a newer delivery's ack already wrote", async () => {
    // The older-writer-after-newer-writer case. Two acks for different
    // deliveries can be in flight on separate instances at once, and the slower
    // one carries the OLDER entry; last-write-wins would let it overwrite the
    // newer verdict. The guard travels in the WHERE, so Postgres — not this
    // process — decides it, and a duplicate or superseded ack matches no row.
    const captured = captureUpdate(DesktopCommandStatus.Running);

    await desktopCommandStore.acknowledgeCommand(
      COMMAND_ID,
      true,
      undefined,
      TARGET_ID
    );

    expect(captured.where).toMatchObject({
      OR: [{ ackedAt: null }, { ackedAt: { lt: QUEUED_AT } }],
    });
  });
});
