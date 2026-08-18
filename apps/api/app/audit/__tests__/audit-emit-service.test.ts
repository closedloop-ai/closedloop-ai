/**
 * Unit tests for the async, non-blocking audit emit path (FEA-3862 Slice 1c).
 *
 * These mock `@repo/database` and the ledger append so they exercise the emit
 * and drain control flow in isolation — no Postgres. The DB-backed proofs
 * (real gap-free seq under the advisory lock, an emitted event surviving a
 * round-trip through the outbox and verifying) live in the integration suite
 * (__tests__/integration/audit-ledger.test.ts).
 *
 * The load-bearing property here is FAILURE ISOLATION: a thrown outbox insert
 * must never surface to the caller (the user's action must still succeed), and
 * a poison outbox row must not abort a whole drain pass.
 */
import {
  AuditAction,
  AuditActorType,
  AuditObjectType,
} from "@repo/api/src/types/audit";
import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  mockOutboxCreate,
  mockOutboxCreateMany,
  mockOutboxFindMany,
  mockOutboxUpdateMany,
  mockAppendClaimingOutbox,
  mockWaitUntil,
} = vi.hoisted(() => ({
  mockOutboxCreate: vi.fn(),
  mockOutboxCreateMany: vi.fn(),
  mockOutboxFindMany: vi.fn(),
  mockOutboxUpdateMany: vi.fn(),
  mockAppendClaimingOutbox: vi.fn(),
  mockWaitUntil: vi.fn(),
}));

vi.mock("@vercel/functions", () => ({
  waitUntil: mockWaitUntil,
}));

vi.mock("@repo/database", () => {
  const db = {
    auditOutbox: {
      create: mockOutboxCreate,
      createMany: mockOutboxCreateMany,
      findMany: mockOutboxFindMany,
      updateMany: mockOutboxUpdateMany,
    },
  };
  return {
    // withDb(fn) hands the caller the mock client (no real pool).
    withDb: (fn: (client: typeof db) => unknown) => fn(db),
    Prisma: {},
  };
});

vi.mock("../audit-ledger-service", () => ({
  auditLedgerService: { appendClaimingOutbox: mockAppendClaimingOutbox },
}));

import {
  dispatchAuditEvent,
  dispatchAuditEvents,
  drainAuditOutbox,
  emitAuditEvent,
  emitAuditEvents,
  MAX_DRAIN_ATTEMPTS,
  systemAuditActor,
  userAuditActor,
} from "../audit-emit-service";

const ORG_ID = "11111111-1111-4111-8111-111111111111";
const USER_ID = "22222222-2222-4222-8222-222222222222";

function pendingRow(overrides: Record<string, unknown> = {}) {
  return {
    id: `outbox-${Math.random().toString(16).slice(2)}`,
    organizationId: ORG_ID,
    action: AuditAction.DocumentStatusChanged,
    actorType: AuditActorType.User,
    actorId: USER_ID,
    objectType: AuditObjectType.Document,
    objectId: "doc-1",
    detail: { to: "APPROVED" },
    attempts: 0,
    ...overrides,
  };
}

describe("audit emit actor helpers", () => {
  it("attributes an authenticated request to a user actor", () => {
    expect(userAuditActor(USER_ID)).toEqual({
      actorType: AuditActorType.User,
      actorId: USER_ID,
    });
  });

  it("attributes an unattributed internal path to a system actor", () => {
    expect(systemAuditActor()).toEqual({
      actorType: AuditActorType.System,
      actorId: null,
    });
  });
});

describe("emitAuditEvent", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("writes one outbox row with the correct action/object/actor", async () => {
    mockOutboxCreate.mockResolvedValue({ id: "outbox-1" });

    await emitAuditEvent({
      organizationId: ORG_ID,
      actor: userAuditActor(USER_ID),
      action: AuditAction.ApiKeyMinted,
      objectType: AuditObjectType.ApiKey,
      objectId: "key-1",
      detail: { name: "ci" },
    });

    expect(mockOutboxCreate).toHaveBeenCalledTimes(1);
    expect(mockOutboxCreate.mock.calls[0][0]).toEqual({
      data: {
        organizationId: ORG_ID,
        action: AuditAction.ApiKeyMinted,
        actorType: AuditActorType.User,
        actorId: USER_ID,
        objectType: AuditObjectType.ApiKey,
        objectId: "key-1",
        detail: { name: "ci" },
      },
    });
  });

  it("defaults missing detail to an empty object", async () => {
    mockOutboxCreate.mockResolvedValue({ id: "outbox-2" });

    await emitAuditEvent({
      organizationId: ORG_ID,
      actor: systemAuditActor(),
      action: AuditAction.ApiKeyRevoked,
      objectType: AuditObjectType.ApiKey,
      objectId: "key-2",
    });

    expect(mockOutboxCreate.mock.calls[0][0].data.detail).toEqual({});
  });

  it("dispatchAuditEvent is fire-and-forget: hands the emit promise to waitUntil off the response path", () => {
    mockOutboxCreate.mockResolvedValue({ id: "outbox-3" });

    // Returns void synchronously — the caller never awaits it on the hot path.
    const returned = dispatchAuditEvent({
      organizationId: ORG_ID,
      actor: userAuditActor(USER_ID),
      action: AuditAction.DocumentStatusChanged,
      objectType: AuditObjectType.Document,
      objectId: "doc-3",
      detail: { to: "APPROVED" },
    });

    expect(returned).toBeUndefined();
    expect(mockWaitUntil).toHaveBeenCalledTimes(1);
    // The scheduled work is the (non-throwing) emit promise.
    expect(mockWaitUntil.mock.calls[0][0]).toBeInstanceOf(Promise);
  });

  it("FAILURE ISOLATION: a thrown outbox insert never rejects to the caller", async () => {
    mockOutboxCreate.mockRejectedValue(new Error("db down"));

    // Must resolve, not reject — the user's action must not fail because the
    // ledger enqueue failed.
    await expect(
      emitAuditEvent({
        organizationId: ORG_ID,
        actor: userAuditActor(USER_ID),
        action: AuditAction.DocumentStatusChanged,
        objectType: AuditObjectType.Document,
        objectId: "doc-9",
        detail: { to: "APPROVED" },
      })
    ).resolves.toBeUndefined();
  });
});

describe("emitAuditEvents (bulk)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("enqueues MANY events in a SINGLE bulk createMany (bounded fan-out)", async () => {
    mockOutboxCreateMany.mockResolvedValue({ count: 3 });

    await emitAuditEvents([
      {
        organizationId: ORG_ID,
        actor: userAuditActor(USER_ID),
        action: AuditAction.DocumentStatusChanged,
        objectType: AuditObjectType.Document,
        objectId: "doc-a",
        detail: { to: "APPROVED", batch: true },
      },
      {
        organizationId: ORG_ID,
        actor: userAuditActor(USER_ID),
        action: AuditAction.DocumentStatusChanged,
        objectType: AuditObjectType.Document,
        objectId: "doc-b",
        detail: { to: "APPROVED", batch: true },
      },
      {
        organizationId: ORG_ID,
        actor: systemAuditActor(),
        action: AuditAction.DocumentStatusChanged,
        objectType: AuditObjectType.Document,
        objectId: "doc-c",
      },
    ]);

    // ONE pooled write for the whole batch, never one create per event.
    expect(mockOutboxCreateMany).toHaveBeenCalledTimes(1);
    expect(mockOutboxCreate).not.toHaveBeenCalled();
    const rows = mockOutboxCreateMany.mock.calls[0][0].data;
    expect(rows).toHaveLength(3);
    expect(rows[0]).toEqual({
      organizationId: ORG_ID,
      action: AuditAction.DocumentStatusChanged,
      actorType: AuditActorType.User,
      actorId: USER_ID,
      objectType: AuditObjectType.Document,
      objectId: "doc-a",
      detail: { to: "APPROVED", batch: true },
    });
    // Missing detail defaults to {}.
    expect(rows[2].detail).toEqual({});
  });

  it("is a no-op for an empty batch (no DB write)", async () => {
    await emitAuditEvents([]);
    expect(mockOutboxCreateMany).not.toHaveBeenCalled();
  });

  it("FAILURE ISOLATION: a thrown bulk insert never rejects to the caller", async () => {
    mockOutboxCreateMany.mockRejectedValue(new Error("db down"));

    await expect(
      emitAuditEvents([
        {
          organizationId: ORG_ID,
          actor: userAuditActor(USER_ID),
          action: AuditAction.DocumentStatusChanged,
          objectType: AuditObjectType.Document,
          objectId: "doc-x",
        },
      ])
    ).resolves.toBeUndefined();
  });

  it("dispatchAuditEvents is fire-and-forget: hands the bulk promise to waitUntil", () => {
    mockOutboxCreateMany.mockResolvedValue({ count: 1 });

    const returned = dispatchAuditEvents([
      {
        organizationId: ORG_ID,
        actor: userAuditActor(USER_ID),
        action: AuditAction.DocumentStatusChanged,
        objectType: AuditObjectType.Document,
        objectId: "doc-y",
      },
    ]);

    expect(returned).toBeUndefined();
    expect(mockWaitUntil).toHaveBeenCalledTimes(1);
    expect(mockWaitUntil.mock.calls[0][0]).toBeInstanceOf(Promise);
  });
});

describe("drainAuditOutbox", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockOutboxUpdateMany.mockResolvedValue({ count: 1 });
  });

  it("claims+appends each pending row atomically (idempotent re-drain)", async () => {
    const rows = [pendingRow({ id: "a" }), pendingRow({ id: "b" })];
    mockOutboxFindMany.mockResolvedValue(rows);
    mockAppendClaimingOutbox.mockResolvedValue({
      claimed: true,
      head: { seq: "1", hash: "h" },
    });

    const summary = await drainAuditOutbox();

    expect(summary).toEqual({
      claimed: 2,
      appended: 2,
      skipped: 0,
      failed: 0,
      remaining: 0,
    });
    expect(mockAppendClaimingOutbox).toHaveBeenCalledTimes(2);
    // The append claims by the row id and derives the input from the row
    // (actorType coerced from the stored string).
    expect(mockAppendClaimingOutbox.mock.calls[0][0]).toBe("a");
    expect(mockAppendClaimingOutbox.mock.calls[0][1]).toMatchObject({
      organizationId: ORG_ID,
      action: AuditAction.DocumentStatusChanged,
      actorType: AuditActorType.User,
      objectType: AuditObjectType.Document,
    });
    // The dead-letter cap is passed to the claim so the DELETE enforces it —
    // a row past the cap is never appended, even from a stale batch snapshot.
    expect(mockAppendClaimingOutbox.mock.calls[0][2]).toBe(MAX_DRAIN_ATTEMPTS);
    // No separate delete — the claim+delete is atomic inside the ledger tx.
    expect(mockOutboxUpdateMany).not.toHaveBeenCalled();
  });

  it("parks poison rows: the drain batch excludes rows past the max-attempts cap", async () => {
    mockOutboxFindMany.mockResolvedValue([]);

    await drainAuditOutbox();

    // The dead-letter cap is enforced in the query, so a poison row whose
    // attempts have reached MAX_DRAIN_ATTEMPTS is never re-claimed and cannot
    // occupy the batch limit ahead of newer events.
    expect(mockOutboxFindMany).toHaveBeenCalledTimes(1);
    expect(mockOutboxFindMany.mock.calls[0][0]).toMatchObject({
      where: { attempts: { lt: MAX_DRAIN_ATTEMPTS } },
      orderBy: { createdAt: "asc" },
    });
  });

  it("re-draining an empty outbox appends nothing", async () => {
    mockOutboxFindMany.mockResolvedValue([]);

    const summary = await drainAuditOutbox();

    expect(summary).toEqual({
      claimed: 0,
      appended: 0,
      skipped: 0,
      failed: 0,
      remaining: 0,
    });
    expect(mockAppendClaimingOutbox).not.toHaveBeenCalled();
  });

  it("counts a row another drain already claimed as skipped, not appended", async () => {
    const rows = [pendingRow({ id: "taken" }), pendingRow({ id: "mine" })];
    mockOutboxFindMany.mockResolvedValue(rows);
    mockAppendClaimingOutbox
      // First row was already claimed+appended by a concurrent drain.
      .mockResolvedValueOnce({ claimed: false })
      .mockResolvedValueOnce({ claimed: true, head: { seq: "5", hash: "h" } });

    const summary = await drainAuditOutbox();

    expect(summary).toEqual({
      claimed: 2,
      appended: 1,
      skipped: 1,
      failed: 0,
      remaining: 0,
    });
    // A skipped row is not a failure — its attempts are not bumped.
    expect(mockOutboxUpdateMany).not.toHaveBeenCalled();
  });

  it("a poison row does not abort the pass; it bumps attempts and continues", async () => {
    const rows = [pendingRow({ id: "poison" }), pendingRow({ id: "good" })];
    mockOutboxFindMany.mockResolvedValue(rows);
    mockAppendClaimingOutbox
      .mockRejectedValueOnce(new Error("append failed"))
      .mockResolvedValueOnce({ claimed: true, head: { seq: "1", hash: "h" } });

    const summary = await drainAuditOutbox();

    expect(summary).toEqual({
      claimed: 2,
      appended: 1,
      skipped: 0,
      failed: 1,
      remaining: 0,
    });
    // The poison row was NOT claimed/deleted; its attempts were incremented so
    // it retries next pass without blocking the good row that followed it. The
    // increment is a cap-guarded updateMany, so an overlapping settlement cannot
    // push attempts past the dead-letter cap.
    expect(mockOutboxUpdateMany).toHaveBeenCalledTimes(1);
    expect(mockOutboxUpdateMany.mock.calls[0][0]).toMatchObject({
      where: { id: "poison", attempts: { lt: MAX_DRAIN_ATTEMPTS } },
      data: { attempts: { increment: 1 } },
    });
  });

  it("stops claiming new rows once the pass budget is spent, leaving the rest for the next pass", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-27T00:00:00.000Z"));
    try {
      const rows = [
        pendingRow({ id: "r1" }),
        pendingRow({ id: "r2" }),
        pendingRow({ id: "r3" }),
      ];
      mockOutboxFindMany.mockResolvedValue(rows);
      // Each append consumes the whole pass budget (contended advisory lock), so
      // after the first row the deadline is blown and the rest are left pending.
      const passBudgetMs = 60_000;
      mockAppendClaimingOutbox.mockImplementation(() => {
        vi.setSystemTime(Date.now() + passBudgetMs);
        return Promise.resolve({
          claimed: true,
          head: { seq: "1", hash: "h" },
        });
      });

      const summary = await drainAuditOutbox(rows.length, passBudgetMs);

      // Only the first row is claimed; the in-flight append is never interrupted
      // and the two rows behind it are reported as remaining, not failed.
      expect(summary).toEqual({
        claimed: 3,
        appended: 1,
        skipped: 0,
        failed: 0,
        remaining: 2,
      });
      expect(mockAppendClaimingOutbox).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
