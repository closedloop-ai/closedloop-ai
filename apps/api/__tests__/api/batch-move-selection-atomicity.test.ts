/**
 * POST /documents/batch-move — the move, its selection lock, and its activity
 * receipt are ONE transaction.
 *
 * ISS-10993 put the move and its receipt in one transaction; ISS-9579 review
 * (whitlockk) found the selection resolving outside it. What each case here pins is
 * a different half of that: that the receipt runs inside the awaited
 * transaction callback, so a receipt that cannot be written refuses the move
 * rather than leaving a moved document with no feed entry; and that the lock
 * runs on that same transaction ahead of the service.
 *
 * It does NOT pin Postgres rolling back — `withDb.tx` is mocked here, so what is
 * observable is that the rejection propagates out of the transaction callback,
 * which is the condition under which Postgres rolls back.
 */
import { Result } from "@repo/api/src/types/result";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AuthContext } from "@/lib/auth/with-auth";
import {
  createMockRequest,
  createMockRouteContext,
  createTestAuthContext,
} from "../utils/auth-helpers";

const ORGANIZATION_ID = "test-org-id";
const ASSIGNEE_ID = "11111111-1111-4111-8111-111111111111";
const TARGET_PROJECT_ID = "33333333-3333-4333-8333-333333333333";
const RESOLVED_A = "44444444-4444-4444-8444-444444444444";
const RESOLVED_B = "55555555-5555-4555-8555-555555555555";

let mockAuthContext: AuthContext;

const mocks = vi.hoisted(() => ({
  batchMove: vi.fn(),
  captureBatchMoveActivity: vi.fn(),
  emitBatchMoveSideEffects: vi.fn(),
  findMany: vi.fn(),
  queryRaw: vi.fn(),
  tx: vi.fn(),
  withDb: vi.fn(),
}));

vi.mock("@repo/database", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  withDb: Object.assign(mocks.withDb, { tx: mocks.tx }),
}));

vi.mock("@/lib/auth/with-any-auth", () => ({
  withAnyAuth:
    (handler: (...args: unknown[]) => Promise<Response>) =>
    (request: unknown, context?: { params: Promise<unknown> }) =>
      handler(mockAuthContext, request, context?.params),
}));
vi.mock("@/app/documents/document-batch-move-service", () => ({
  documentBatchMoveService: { batchMove: mocks.batchMove },
}));
vi.mock("@/lib/batch-move-side-effects", () => ({
  captureBatchMoveActivity: (...args: unknown[]) =>
    mocks.captureBatchMoveActivity(...args),
  emitBatchMoveSideEffects: (...args: unknown[]) =>
    mocks.emitBatchMoveSideEffects(...args),
}));

import { POST } from "@/app/documents/batch-move/route";

function selectionRequest() {
  return createMockRequest({
    url: "http://localhost:3002/api/documents/batch-move",
    method: "POST",
    body: {
      selection: { query: { assigneeId: ASSIGNEE_ID } },
      targetProjectId: TARGET_PROJECT_ID,
    },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mockAuthContext = createTestAuthContext();
  mocks.findMany.mockResolvedValue([{ id: RESOLVED_A }, { id: RESOLVED_B }]);
  mocks.withDb.mockImplementation(
    async (callback: (db: unknown) => unknown) =>
      await callback({ artifact: { findMany: mocks.findMany } })
  );
  mocks.queryRaw.mockResolvedValue([{ id: RESOLVED_A }, { id: RESOLVED_B }]);
  mocks.tx.mockImplementation(
    async (callback: (tx: unknown) => unknown) =>
      await callback({ $queryRaw: mocks.queryRaw })
  );
  mocks.batchMove.mockResolvedValue(
    Result.ok({ movedIds: [RESOLVED_A, RESOLVED_B], projectChanges: [] })
  );
});

describe("POST /documents/batch-move over a query selection", () => {
  it("refuses the move when its activity receipt cannot be written", async () => {
    mocks.captureBatchMoveActivity.mockRejectedValue(new Error("receipt down"));

    const response = await POST(selectionRequest(), createMockRouteContext({}));

    // Not a 200: the receipt rejected INSIDE the awaited transaction callback,
    // so the move it shares that transaction with cannot have committed.
    expect(response.status).toBe(500);
    expect(mocks.captureBatchMoveActivity).toHaveBeenCalledTimes(1);
    expect(mocks.emitBatchMoveSideEffects).not.toHaveBeenCalled();
  });

  it("writes the receipt on the transaction the move runs on", async () => {
    await POST(selectionRequest(), createMockRouteContext({}));

    expect(mocks.tx).toHaveBeenCalledTimes(1);
    const [receiptTx] = mocks.captureBatchMoveActivity.mock.calls[0] as [
      { $queryRaw: unknown },
    ];
    expect(receiptTx.$queryRaw).toBe(mocks.queryRaw);
  });

  it("locks the resolved rows on that transaction before the service moves them", async () => {
    await POST(selectionRequest(), createMockRouteContext({}));

    expect(mocks.queryRaw).toHaveBeenCalledTimes(1);
    expect(mocks.queryRaw.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.batchMove.mock.invocationCallOrder[0]
    );
    expect(mocks.batchMove).toHaveBeenCalledWith(
      [RESOLVED_A, RESOLVED_B],
      TARGET_PROJECT_ID,
      ORGANIZATION_ID
    );
  });

  it("moves only the rows still held when one was deleted under the batch", async () => {
    mocks.queryRaw.mockResolvedValue([{ id: RESOLVED_B }]);

    const response = await POST(selectionRequest(), createMockRouteContext({}));

    expect(response.status).toBe(200);
    expect(mocks.batchMove).toHaveBeenCalledWith(
      [RESOLVED_B],
      TARGET_PROJECT_ID,
      ORGANIZATION_ID
    );
  });
});
