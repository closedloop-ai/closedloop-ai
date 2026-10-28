import type { CreateDesktopCommandInput } from "@repo/api/src/types/compute-target";
import { DesktopCommandStatus } from "@repo/api/src/types/compute-target";
import { log } from "@repo/observability/log";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { StoredCommandRow } from "@/lib/desktop-command-mappers";

/**
 * ISS-7561: the P2002 recovery branches of `createCommand`, against a fake
 * Prisma.
 *
 * These branches are decided by a unique-constraint violation raised by a
 * concurrent writer, so the DB lane can create the duplicate but cannot make
 * the two writers race — `recoverDuplicateCommand`'s two throw sites were
 * unreachable from any test. Forcing P2002 on `create` here reaches them, and
 * puts the coverage in the DEFAULT lane so it runs on every PR rather than
 * only where `DATABASE_URL` is set (`.integration.test.ts` is claimed by
 * `vitest.config.integration.mts`).
 *
 * Both `recoverDuplicateCommand` throw sites raise the SAME
 * `IdempotencyConflictError`, so the class cannot tell them apart. Each is
 * driven separately instead: one with no winner row, one with a winner whose
 * fingerprint differs. The matching-fingerprint case below is the control that
 * makes the mismatch case non-vacuous — same P2002, same winner row, and it
 * resolves instead of throwing.
 */

const mocks = vi.hoisted(() => ({
  withDb: vi.fn(),
}));

vi.mock("@repo/database", () => ({
  withDb: mocks.withDb,
}));

vi.mock("@repo/observability/log", () => ({
  log: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

import { desktopCommandStore } from "@/lib/desktop-command-store";

const TARGET_ID = "target-1";
const RACE_KEY = "race-key";
const CREATED_AT = new Date("2026-08-22T12:00:00.000Z");

function uniqueViolation(): Error {
  return Object.assign(new Error("Unique constraint failed"), {
    code: "P2002",
  });
}

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

function storedRow(requestFingerprint: string): StoredCommandRow {
  return {
    id: "command-winner",
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
    idempotencyKey: RACE_KEY,
    requestFingerprint,
  };
}

type FakeDb = {
  findFirst: ReturnType<typeof vi.fn>;
  create: ReturnType<typeof vi.fn>;
};

function installDb(): FakeDb {
  const delegate: FakeDb = {
    findFirst: vi.fn().mockResolvedValue(null),
    create: vi.fn().mockRejectedValue(uniqueViolation()),
  };
  const db = { desktopCommand: delegate };
  mocks.withDb.mockImplementation((callback: (client: unknown) => unknown) =>
    callback(db)
  );
  return delegate;
}

/**
 * Resolves the second `findFirst` — the one inside `recoverDuplicateCommand` —
 * from the fingerprint production actually computed and handed to `create`,
 * rather than recomputing it in the test.
 *
 * The winner is returned ONLY for a lookup scoped to BOTH this compute target
 * and this idempotency key. A fake that ignored its arguments would keep these
 * tests green if `recoverDuplicateCommand` dropped `computeTargetId` from its
 * `where` and deduped a command belonging to another target.
 */
function answerRecoveryWith(
  db: FakeDb,
  winner: (createdFingerprint: string) => StoredCommandRow | null
): void {
  db.findFirst
    .mockResolvedValueOnce(null)
    .mockImplementation((args: { where?: Record<string, unknown> }) => {
      const where = args?.where ?? {};
      if (
        where.computeTargetId !== TARGET_ID ||
        where.idempotencyKey !== RACE_KEY
      ) {
        return Promise.resolve(null);
      }
      const createArgs = db.create.mock.calls[0]?.[0] as {
        data: { requestFingerprint: string };
      };
      return Promise.resolve(winner(createArgs.data.requestFingerprint));
    });
}

/**
 * The `where` the recovery lookup must carry. Asserted as the SECOND
 * `findFirst` call in each recovery test, pinning the lookup's scope directly
 * rather than only through its result: both `recoverDuplicateCommand` throw
 * sites raise the same class, so dropping `computeTargetId` moves the
 * fingerprint-mismatch case onto the no-winner branch without changing the
 * class the caller sees, and only the call shape catches that one.
 */
const RECOVERY_LOOKUP_WHERE = {
  computeTargetId: TARGET_ID,
  idempotencyKey: RACE_KEY,
} as const;

describe("desktopCommandStore.createCommand — P2002 recovery (ISS-7561)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    desktopCommandStore.__resetForTests();
  });

  it("throws IdempotencyConflictError when the race leaves no winner row", async () => {
    const db = installDb();
    answerRecoveryWith(db, () => null);

    await expect(
      desktopCommandStore.createCommand(
        TARGET_ID,
        commandInput({ idempotencyKey: RACE_KEY })
      )
    ).rejects.toThrow(desktopCommandStore.IdempotencyConflictError);

    // Two lookups: the pre-create dedupe check, then the post-P2002 recovery.
    // One call would mean the P2002 never routed into recoverDuplicateCommand.
    expect(db.findFirst).toHaveBeenCalledTimes(2);
    expect(db.findFirst).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ where: RECOVERY_LOOKUP_WHERE })
    );
  });

  it("throws IdempotencyConflictError when the winner carries a different fingerprint", async () => {
    const db = installDb();
    answerRecoveryWith(db, (fingerprint) => storedRow(`${fingerprint}-other`));

    await expect(
      desktopCommandStore.createCommand(
        TARGET_ID,
        commandInput({ idempotencyKey: RACE_KEY })
      )
    ).rejects.toThrow(desktopCommandStore.IdempotencyConflictError);

    expect(db.findFirst).toHaveBeenCalledTimes(2);
    expect(db.findFirst).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ where: RECOVERY_LOOKUP_WHERE })
    );
  });

  it("returns the winner as deduped when its fingerprint matches", async () => {
    const db = installDb();
    answerRecoveryWith(db, (fingerprint) => storedRow(fingerprint));

    const result = await desktopCommandStore.createCommand(
      TARGET_ID,
      commandInput({ idempotencyKey: RACE_KEY })
    );

    expect(result).toEqual({
      command: expect.objectContaining({ commandId: "command-winner" }),
      deduped: true,
    });
    expect(db.findFirst).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ where: RECOVERY_LOOKUP_WHERE })
    );
  });

  it("throws ClientCommandIdConflictError when a caller-supplied commandId collides", async () => {
    const db = installDb();

    await expect(
      desktopCommandStore.createCommand(
        TARGET_ID,
        commandInput({ commandId: "01920000-0000-7000-8000-000000000001" })
      )
    ).rejects.toThrow(desktopCommandStore.ClientCommandIdConflictError);

    // No idempotency key, so nothing looks for a winner — the collision is on
    // the primary key and there is no dedupe to recover.
    expect(db.findFirst).not.toHaveBeenCalled();
  });

  it("rethrows a P2002 that belongs to neither conflict class", async () => {
    installDb();

    // Neither a client command id nor an idempotency key: the unique violation
    // is on something else entirely and must not be laundered into a 409.
    // Asserting the Prisma `code` survives is what pins that — neither conflict
    // class carries one, so a mapped error fails this.
    await expect(
      desktopCommandStore.createCommand(TARGET_ID, commandInput())
    ).rejects.toMatchObject({ code: "P2002" });
  });

  it("rethrows a non-P2002 create failure unchanged", async () => {
    const db = installDb();
    db.create.mockRejectedValue(
      Object.assign(new Error("connection lost"), { code: "P1001" })
    );

    await expect(
      desktopCommandStore.createCommand(
        TARGET_ID,
        commandInput({ idempotencyKey: RACE_KEY })
      )
    ).rejects.toThrow("connection lost");
    // The recovery lookup must not run for a failure that is not a duplicate.
    expect(db.findFirst).toHaveBeenCalledTimes(1);
  });
});

describe("desktopCommandStore.createCommand — timeoutMs at ingress (ISS-8233)", () => {
  const MAX = 2_147_483_647;

  beforeEach(() => {
    vi.clearAllMocks();
    desktopCommandStore.__resetForTests();
  });

  /** A db whose `create` succeeds, echoing back whatever payload it was given. */
  function installWritableDb(): FakeDb {
    const db = installDb();
    db.create.mockImplementation((args: { data: StoredCommandRow }) =>
      Promise.resolve({ ...storedRow("fp"), ...args.data, id: "command-1" })
    );
    return db;
  }

  /**
   * The row a create actually wrote. The presence check names a create that
   * never happened, rather than letting it surface as a property access on
   * undefined in whichever reader got there first.
   */
  function persistedCreateData(db: FakeDb): {
    requestFingerprint: string;
    requestPayload: Record<string, unknown>;
  } {
    const call = db.create.mock.calls[0];
    if (!call) {
      throw new Error("no desktop command row was created");
    }
    return (
      call[0] as {
        data: {
          requestFingerprint: string;
          requestPayload: Record<string, unknown>;
        };
      }
    ).data;
  }

  function persistedPayload(db: FakeDb): Record<string, unknown> {
    return persistedCreateData(db).requestPayload;
  }

  it("persists a clamped timeout, never the raw out-of-range one", async () => {
    // The REST route bounds `timeoutMs` `.positive()` with NO ceiling, so
    // without normalization here the raw value is written to
    // `desktop_commands` and replayed onto the wire on every reconnect.
    const db = installWritableDb();

    await desktopCommandStore.createCommand(
      TARGET_ID,
      commandInput({ timeoutMs: MAX + 1 })
    );

    expect(persistedPayload(db).timeoutMs).toBe(MAX);
  });

  it("persists no timeout key at all for a nonpositive one", async () => {
    const db = installWritableDb();

    await desktopCommandStore.createCommand(
      TARGET_ID,
      commandInput({ timeoutMs: -5 })
    );

    expect(Object.hasOwn(persistedPayload(db), "timeoutMs")).toBe(false);
  });

  it("fingerprints the normalized value, so transport cannot change the hash", async () => {
    // A relay caller arrives pre-clamped and a REST caller does not. Both must
    // land on one hash or a retry raises a false IdempotencyConflictError.
    const rawDb = installWritableDb();
    await desktopCommandStore.createCommand(
      TARGET_ID,
      commandInput({ timeoutMs: MAX + 1 })
    );
    const rawFingerprint = persistedCreateData(rawDb).requestFingerprint;

    vi.clearAllMocks();
    desktopCommandStore.__resetForTests();
    const clampedDb = installWritableDb();
    await desktopCommandStore.createCommand(
      TARGET_ID,
      commandInput({ timeoutMs: MAX })
    );
    const clampedFingerprint =
      persistedCreateData(clampedDb).requestFingerprint;

    expect(rawFingerprint).toBe(clampedFingerprint);
  });

  it("routes the rejected value to the monitored warn, and stays quiet otherwise", async () => {
    installWritableDb();
    await desktopCommandStore.createCommand(
      TARGET_ID,
      commandInput({ timeoutMs: MAX + 1 })
    );

    expect(log.warn).toHaveBeenCalledWith(
      "createCommand: timeoutMs out of range, normalized",
      expect.objectContaining({ value: MAX + 1, clampedTo: MAX })
    );

    vi.clearAllMocks();
    desktopCommandStore.__resetForTests();
    installWritableDb();
    await desktopCommandStore.createCommand(
      TARGET_ID,
      commandInput({ timeoutMs: 30_000 })
    );

    expect(log.warn).not.toHaveBeenCalled();
  });
});
