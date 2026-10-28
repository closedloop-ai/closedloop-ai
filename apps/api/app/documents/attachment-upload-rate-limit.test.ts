import { AttachmentUploadError } from "@repo/api/src/types/attachment";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * No test file previously covered this rate limiter at all — every test here
 * targets a race-recovery or error-classification arm that only a
 * fixed-window limiter with concurrent writers actually reaches: a lost
 * update race that turns out to be an expired window (reset), a lost RESET
 * race that has to re-read (and possibly recurse), the limiter row vanishing
 * out from under a caller, and the first-window unique-constraint race
 * recovering in a fresh transaction after the original poisons.
 */

const withDbMock = vi.hoisted(() => vi.fn());
const withDbTx = vi.hoisted(() => vi.fn());
const getPrismaErrorCode = vi.hoisted(() => vi.fn());
const mockLog = vi.hoisted(() => ({
  warn: vi.fn(),
  error: vi.fn(),
  info: vi.fn(),
}));

vi.mock("@repo/database", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@repo/database")>()),
  withDb: Object.assign(withDbMock, { tx: withDbTx }),
}));
vi.mock("@/lib/db-utils", () => ({ getPrismaErrorCode }));
vi.mock("@repo/observability/log", () => ({ log: mockLog }));

import { consumeAttachmentUploadLimit } from "./attachment-upload-rate-limit";

const ORG = "org-1";
const DOC = "doc-1";
const NOW = new Date("2026-09-27T12:00:00.000Z");
const FUTURE = new Date("2026-09-27T12:30:00.000Z");
const PAST = new Date("2026-09-27T11:00:00.000Z");

function makeDb(overrides: {
  deleteMany?: ReturnType<typeof vi.fn>;
  findUnique?: ReturnType<typeof vi.fn>;
  updateMany?: ReturnType<typeof vi.fn>;
  create?: ReturnType<typeof vi.fn>;
}) {
  return {
    oAuthRateLimit: {
      deleteMany:
        overrides.deleteMany ?? vi.fn().mockResolvedValue({ count: 0 }),
      findUnique: overrides.findUnique ?? vi.fn(),
      updateMany: overrides.updateMany ?? vi.fn(),
      create: overrides.create ?? vi.fn().mockResolvedValue({ id: "row-1" }),
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  getPrismaErrorCode.mockReturnValue(undefined);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("consumeAttachmentUploadLimit — cleanup failure is logged, never thrown", () => {
  it("logs a caught Error's message when the cleanup sweep fails", async () => {
    const cleanupDb = makeDb({
      deleteMany: vi.fn().mockRejectedValue(new Error("connection reset")),
    });
    withDbMock.mockImplementation((fn: (db: unknown) => unknown) =>
      fn(cleanupDb)
    );
    withDbTx.mockImplementation((fn: (db: unknown) => unknown) =>
      fn(
        makeDb({
          findUnique: vi.fn().mockResolvedValue(null),
          create: vi.fn().mockResolvedValue({ id: "row-1" }),
        })
      )
    );

    await consumeAttachmentUploadLimit(ORG, DOC);

    expect(mockLog.warn).toHaveBeenCalledWith(
      "[attachments-service] Failed to clean up expired attachment upload limiter rows",
      expect.objectContaining({ error: "connection reset" })
    );
  });

  it("stringifies a non-Error rejection from the cleanup sweep", async () => {
    const cleanupDb = makeDb({
      deleteMany: vi.fn().mockRejectedValue("disk full"),
    });
    withDbMock.mockImplementation((fn: (db: unknown) => unknown) =>
      fn(cleanupDb)
    );
    withDbTx.mockImplementation((fn: (db: unknown) => unknown) =>
      fn(
        makeDb({
          findUnique: vi.fn().mockResolvedValue(null),
          create: vi.fn().mockResolvedValue({ id: "row-1" }),
        })
      )
    );

    await consumeAttachmentUploadLimit(ORG, DOC);

    expect(mockLog.warn).toHaveBeenCalledWith(
      "[attachments-service] Failed to clean up expired attachment upload limiter rows",
      expect.objectContaining({ error: "disk full" })
    );
  });
});

describe("consumeAttachmentUploadLimit — lost update race", () => {
  beforeEach(() => {
    withDbMock.mockImplementation((fn: (db: unknown) => unknown) =>
      fn(makeDb({}))
    );
  });

  it("throws when the limiter row vanishes after losing the increment race", async () => {
    const findUnique = vi
      .fn()
      // Initial read inside the transaction: an active, non-expired window.
      .mockResolvedValueOnce({
        id: "row-1",
        requestCount: 5,
        windowExpiresAt: FUTURE,
      })
      // Re-read after the lost race: the row is gone.
      .mockResolvedValueOnce(null);
    const updateMany = vi.fn().mockResolvedValue({ count: 0 });
    withDbTx.mockImplementation((fn: (db: unknown) => unknown) =>
      fn(makeDb({ findUnique, updateMany }))
    );

    await expect(consumeAttachmentUploadLimit(ORG, DOC)).rejects.toThrow(
      "Attachment upload limiter row disappeared"
    );
    // The re-read is scoped to this exact (org, document) subject, not a
    // canned read that would answer for any caller's row.
    expect(findUnique).toHaveBeenCalledWith({
      where: {
        bucket_subject: {
          bucket: "document_attachment_upload_request",
          subject: `${ORG}:${DOC}`,
        },
      },
      select: { id: true, requestCount: true, windowExpiresAt: true },
    });
  });

  it("resets the window when a lost increment race turns out to be an expired window", async () => {
    const findUnique = vi
      .fn()
      .mockResolvedValueOnce({
        id: "row-1",
        requestCount: 60,
        windowExpiresAt: FUTURE,
      })
      // Re-read: a concurrent writer already advanced this row past FUTURE.
      // Exactly NOW, not PAST — the guard is `<= now`, and only a value
      // exactly on the boundary can tell that apart from `< now`.
      .mockResolvedValueOnce({
        id: "row-1",
        requestCount: 60,
        windowExpiresAt: NOW,
      });
    const updateMany = vi
      .fn()
      // The increment attempt loses (row no longer matches the guard).
      .mockResolvedValueOnce({ count: 0 })
      // The reset succeeds.
      .mockResolvedValueOnce({ count: 1 });
    withDbTx.mockImplementation((fn: (db: unknown) => unknown) =>
      fn(makeDb({ findUnique, updateMany }))
    );

    const result = await consumeAttachmentUploadLimit(ORG, DOC);

    expect(result.ok).toBe(true);
    expect(updateMany).toHaveBeenCalledTimes(2);
    expect(updateMany.mock.calls[1][0]).toMatchObject({
      where: { id: "row-1", windowExpiresAt: { lte: NOW } },
      data: { requestCount: 1 },
    });
  });

  it("reports rate-limited when the re-read shows a still-active window", async () => {
    const findUnique = vi
      .fn()
      .mockResolvedValueOnce({
        id: "row-1",
        requestCount: 60,
        windowExpiresAt: FUTURE,
      })
      .mockResolvedValueOnce({
        id: "row-1",
        requestCount: 60,
        windowExpiresAt: FUTURE,
      });
    const updateMany = vi.fn().mockResolvedValue({ count: 0 });
    withDbTx.mockImplementation((fn: (db: unknown) => unknown) =>
      fn(makeDb({ findUnique, updateMany }))
    );

    const result = await consumeAttachmentUploadLimit(ORG, DOC);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatchObject({
        type: AttachmentUploadError.RateLimited,
      });
    }
  });
});

describe("consumeAttachmentUploadLimit — lost reset race", () => {
  beforeEach(() => {
    withDbMock.mockImplementation((fn: (db: unknown) => unknown) =>
      fn(makeDb({}))
    );
  });

  it("throws when the limiter row vanishes after losing the reset race", async () => {
    const findUnique = vi
      .fn()
      .mockResolvedValueOnce({
        id: "row-1",
        requestCount: 3,
        windowExpiresAt: PAST,
      })
      .mockResolvedValueOnce(null);
    const updateMany = vi.fn().mockResolvedValue({ count: 0 });
    withDbTx.mockImplementation((fn: (db: unknown) => unknown) =>
      fn(makeDb({ findUnique, updateMany }))
    );

    await expect(consumeAttachmentUploadLimit(ORG, DOC)).rejects.toThrow(
      "Attachment upload limiter row disappeared"
    );
  });

  it("recurses into another reset when the re-read still shows an expired window", async () => {
    const findUnique = vi
      .fn()
      .mockResolvedValueOnce({
        id: "row-1",
        requestCount: 3,
        windowExpiresAt: PAST,
      })
      // Lost reset race re-read: still expired (another writer's reset also
      // lost, or reset a different window) — must recurse, not give up.
      // Exactly NOW, not PAST — the guard is `<= now`, and only a value
      // exactly on the boundary can tell that apart from `< now`.
      .mockResolvedValueOnce({
        id: "row-1",
        requestCount: 3,
        windowExpiresAt: NOW,
      });
    const updateMany = vi
      .fn()
      .mockResolvedValueOnce({ count: 0 })
      // The recursive reset attempt succeeds.
      .mockResolvedValueOnce({ count: 1 });
    withDbTx.mockImplementation((fn: (db: unknown) => unknown) =>
      fn(makeDb({ findUnique, updateMany }))
    );

    const result = await consumeAttachmentUploadLimit(ORG, DOC);

    expect(result.ok).toBe(true);
    expect(updateMany).toHaveBeenCalledTimes(2);
    // The RESET shape specifically (requestCount reinitialized to 1), not
    // consumeExistingWindow's increment shape — proves the recursion actually
    // reached resetExpiredWindow again rather than falling through to the
    // sibling branch, which would also happen to call updateMany twice.
    expect(updateMany.mock.calls[1][0]).toMatchObject({
      where: { id: "row-1", windowExpiresAt: { lte: NOW } },
      data: { requestCount: 1 },
    });
  });

  it("falls through to consuming the existing window when the re-read shows it is no longer expired", async () => {
    const findUnique = vi
      .fn()
      .mockResolvedValueOnce({
        id: "row-1",
        requestCount: 3,
        windowExpiresAt: PAST,
      })
      // Re-read: a concurrent writer already reset this row to a fresh,
      // still-active window.
      .mockResolvedValueOnce({
        id: "row-1",
        requestCount: 1,
        windowExpiresAt: FUTURE,
      });
    const updateMany = vi
      .fn()
      .mockResolvedValueOnce({ count: 0 })
      // consumeExistingWindow's own increment, against the fresh window.
      .mockResolvedValueOnce({ count: 1 });
    withDbTx.mockImplementation((fn: (db: unknown) => unknown) =>
      fn(makeDb({ findUnique, updateMany }))
    );

    const result = await consumeAttachmentUploadLimit(ORG, DOC);

    expect(result.ok).toBe(true);
    expect(updateMany.mock.calls[1][0]).toMatchObject({
      where: {
        id: "row-1",
        requestCount: { lt: 60 },
        windowExpiresAt: { gt: NOW },
      },
      data: { requestCount: { increment: 1 } },
    });
  });
});

describe("consumeAttachmentUploadLimit — first-window create race", () => {
  beforeEach(() => {
    withDbMock.mockImplementation((fn: (db: unknown) => unknown) =>
      fn(makeDb({}))
    );
  });

  it("rethrows a non-unique-constraint failure from the main transaction", async () => {
    const failure = new Error("connection reset");
    getPrismaErrorCode.mockReturnValue("P2025");
    withDbTx.mockImplementationOnce(() => {
      throw failure;
    });

    await expect(consumeAttachmentUploadLimit(ORG, DOC)).rejects.toThrow(
      failure
    );
    expect(withDbTx).toHaveBeenCalledTimes(1);
  });

  it("rethrows the original race error when the recovery transaction finds no row", async () => {
    const raceError = Object.assign(new Error("unique violation"), {
      code: "P2002",
    });
    getPrismaErrorCode.mockReturnValue("P2002");
    withDbTx
      .mockImplementationOnce(() => {
        throw raceError;
      })
      .mockImplementationOnce((fn: (db: unknown) => unknown) =>
        fn(makeDb({ findUnique: vi.fn().mockResolvedValue(null) }))
      );

    await expect(consumeAttachmentUploadLimit(ORG, DOC)).rejects.toThrow(
      raceError
    );
    expect(withDbTx).toHaveBeenCalledTimes(2);
  });

  it("resets the window in the recovery transaction when the winning row's window already expired", async () => {
    const raceError = Object.assign(new Error("unique violation"), {
      code: "P2002",
    });
    getPrismaErrorCode.mockReturnValue("P2002");
    const updateMany = vi.fn().mockResolvedValue({ count: 1 });
    withDbTx
      .mockImplementationOnce(() => {
        throw raceError;
      })
      .mockImplementationOnce((fn: (db: unknown) => unknown) =>
        fn(
          makeDb({
            // Exactly NOW, not PAST — the guard is `<= now`, and only a
            // value exactly on the boundary can tell that apart from `< now`.
            findUnique: vi.fn().mockResolvedValue({
              id: "row-1",
              requestCount: 1,
              windowExpiresAt: NOW,
            }),
            updateMany,
          })
        )
      );

    const result = await consumeAttachmentUploadLimit(ORG, DOC);

    expect(result.ok).toBe(true);
    expect(updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "row-1", windowExpiresAt: { lte: NOW } },
      })
    );
  });
});
