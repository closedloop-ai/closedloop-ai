/**
 * POST /documents/batch-update-priority/v2 (ISS-9464).
 *
 * The service is covered by
 * `app/documents/__tests__/artifact-bulk-priority-per-item.test.ts`. This
 * pins the route's own contract: the scope it registers, which bodies it
 * refuses before reaching the service, the per-item envelope in REQUEST order,
 * and side effects driven off the committed subset.
 */
import { ArtifactStatusEditSurface } from "@repo/api/src/types/artifact-status-contract";
import {
  BATCH_ITEM_APPLIED_STATUS,
  BatchItemFailureCode,
  type BatchItemResult,
  batchItemApplied,
  batchItemFailed,
} from "@repo/api/src/types/batch-mutation-result";
import { Priority } from "@repo/api/src/types/common";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AuthContext } from "@/lib/auth/with-auth";
import {
  createMockRequest,
  createMockRouteContext,
  createTestAuthContext,
} from "../utils/auth-helpers";

let mockAuthContext: AuthContext;

const mocks = vi.hoisted(() => ({
  captureBatchPriorityActivity: vi.fn(),
  batchUpdatePriorityPerItem: vi.fn(),
  emitBatchPrioritySideEffects: vi.fn(),
  emitBatchItemFieldEditRefusalAnalytics: vi.fn(),
  requiredScopes: [] as unknown[],
}));

// ISS-10993: the route opens ONE transaction for the mutation and its activity
// receipt. Every store this suite reaches is mocked, so the real `withDb` would
// only add a Postgres the unit lane does not have.
vi.mock("@repo/database", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  withDb: (await import("@/__tests__/utils/mock-with-db")).mockWithDb(),
}));

vi.mock("@/lib/auth/with-any-auth", () => ({
  withAnyAuth: (
    handler: (...args: unknown[]) => Promise<Response>,
    options?: { requiredScopes?: unknown }
  ) => {
    mocks.requiredScopes.push(options?.requiredScopes);
    return (request: unknown, context?: { params: Promise<unknown> }) =>
      handler(mockAuthContext, request, context?.params);
  },
}));
vi.mock("@/app/documents/artifact-bulk-priority-service", () => ({
  artifactBulkPriorityService: {
    batchUpdatePriorityPerItem: mocks.batchUpdatePriorityPerItem,
  },
}));
vi.mock("@/app/documents/batch-priority-side-effects", () => ({
  captureBatchPriorityActivity: (...args: unknown[]) =>
    mocks.captureBatchPriorityActivity(...args),
  emitBatchPrioritySideEffects: (...args: unknown[]) =>
    mocks.emitBatchPrioritySideEffects(...args),
}));
vi.mock(
  "@/app/documents/batch-field-edit-refusal-analytics",
  async (importOriginal) => ({
    ...(await importOriginal<object>()),
    emitBatchItemFieldEditRefusalAnalytics:
      mocks.emitBatchItemFieldEditRefusalAnalytics,
  })
);

import { POST } from "@/app/documents/batch-update-priority/v2/route";

const DOC_A = "11111111-1111-4111-8111-111111111111";
const DOC_B = "22222222-2222-4222-8222-222222222222";
const STALE_DOC = "99999999-9999-4999-8999-999999999999";

function priorityRequest(documentIds: string[], surface?: string) {
  return createMockRequest({
    url: "http://localhost:3002/documents/batch-update-priority/v2",
    method: "POST",
    body: {
      documentIds,
      priority: Priority.Urgent,
      ...(surface === undefined ? {} : { surface }),
    },
  });
}

function serviceReturns(
  results: BatchItemResult[],
  changedIds: string[] = [],
  beforePriorities: Map<string, Priority | null> = new Map()
) {
  mocks.batchUpdatePriorityPerItem.mockResolvedValue({
    resultsById: new Map(results.map((result) => [result.id, result] as const)),
    changedIds,
    beforePriorities,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mockAuthContext = createTestAuthContext();
  serviceReturns([batchItemApplied(DOC_A)]);
});

describe("POST /documents/batch-update-priority/v2 (ISS-9464)", () => {
  it("is registered demanding the write scope", () => {
    // Length first: an empty array would satisfy a `toEqual` against nothing,
    // which is what a route that stopped declaring scopes would produce.
    expect(mocks.requiredScopes).toHaveLength(1);
    expect(mocks.requiredScopes).toEqual([["write"]]);
  });

  it("returns a 400 envelope on an invalid body, before the service", async () => {
    const response = await POST(
      priorityRequest([]),
      createMockRouteContext({})
    );

    expect(response.status).toBe(400);
    expect(mocks.batchUpdatePriorityPerItem).not.toHaveBeenCalled();
    expect(mocks.emitBatchPrioritySideEffects).not.toHaveBeenCalled();
  });

  it("answers 200 with one result per distinct id in first-appearance order", async () => {
    serviceReturns([
      batchItemApplied(DOC_A),
      batchItemApplied(DOC_B),
      batchItemFailed(STALE_DOC, BatchItemFailureCode.StalePriority),
    ]);

    const response = await POST(
      priorityRequest([DOC_B, STALE_DOC, DOC_A, DOC_B]),
      createMockRouteContext({})
    );

    expect(response.status).toBe(200);
    const json = await response.json();
    expect(json.data.results).toEqual([
      { id: DOC_B, status: BATCH_ITEM_APPLIED_STATUS },
      batchItemFailed(STALE_DOC, BatchItemFailureCode.StalePriority),
      { id: DOC_A, status: BATCH_ITEM_APPLIED_STATUS },
    ]);
    expect(mocks.batchUpdatePriorityPerItem).toHaveBeenCalledWith(
      [DOC_B, STALE_DOC, DOC_A, DOC_B],
      Priority.Urgent,
      mockAuthContext.user.organizationId,
      undefined
    );
    expect(mocks.emitBatchItemFieldEditRefusalAnalytics).toHaveBeenCalledTimes(
      1
    );
    const analyticsInput =
      mocks.emitBatchItemFieldEditRefusalAnalytics.mock.calls[0][0];
    expect(Array.from(analyticsInput.results)).toEqual([
      batchItemApplied(DOC_A),
      batchItemApplied(DOC_B),
      batchItemFailed(STALE_DOC, BatchItemFailureCode.StalePriority),
    ]);
  });

  it("forwards the caller's expected priorities to the service", async () => {
    const expectedPriorityById = { [DOC_A]: Priority.Low };

    await POST(
      createMockRequest({
        url: "http://localhost:3002/documents/batch-update-priority/v2",
        method: "POST",
        body: {
          documentIds: [DOC_A],
          priority: Priority.Urgent,
          expectedPriorityById,
        },
      }),
      createMockRouteContext({})
    );

    // Every other case here sends no expectation and asserts `undefined` in
    // this slot, so a route that dropped the field would keep them all green
    // while the optimistic-concurrency guard was silently off for v2.
    expect(mocks.batchUpdatePriorityPerItem).toHaveBeenCalledWith(
      [DOC_A],
      Priority.Urgent,
      mockAuthContext.user.organizationId,
      expectedPriorityById
    );
  });

  it("emits side effects for the committed subset, never the requested ids", async () => {
    const beforePriorities = new Map<string, Priority | null>([
      [DOC_A, Priority.Medium],
    ]);
    serviceReturns(
      [
        batchItemApplied(DOC_A),
        batchItemFailed(STALE_DOC, BatchItemFailureCode.StalePriority),
      ],
      [DOC_A],
      beforePriorities
    );

    const response = await POST(
      priorityRequest([DOC_A, STALE_DOC], ArtifactStatusEditSurface.Bulk),
      createMockRouteContext({})
    );

    expect(mocks.emitBatchPrioritySideEffects).toHaveBeenCalledTimes(1);
    expect(mocks.emitBatchPrioritySideEffects).toHaveBeenCalledWith({
      user: mockAuthContext.user,
      authMethod: mockAuthContext.authMethod,
      priority: Priority.Urgent,
      surface: ArtifactStatusEditSurface.Bulk,
      changedIds: [DOC_A],
      beforePriorities,
      transactionId: expect.any(String),
      reportNoChange: false,
    });
    // ISS-9465 ruling 4: the id the side effects were given is the one the
    // caller is handed back, so a client can name the group the server wrote.
    const emitted = mocks.emitBatchPrioritySideEffects.mock.calls[0][0];
    const json = await response.json();
    expect(json.data.transactionId).toBe(emitted.transactionId);
  });

  it("does not add no-change analytics when every item is refused", async () => {
    serviceReturns([
      batchItemFailed(STALE_DOC, BatchItemFailureCode.StalePriority),
    ]);

    await POST(priorityRequest([STALE_DOC]), createMockRouteContext({}));

    expect(mocks.emitBatchPrioritySideEffects).toHaveBeenCalledWith(
      expect.objectContaining({ reportNoChange: false })
    );
  });

  it("returns 500 when the service rejects, emitting nothing", async () => {
    mocks.batchUpdatePriorityPerItem.mockRejectedValue(
      new Error("connection reset")
    );

    const response = await POST(
      priorityRequest([DOC_A]),
      createMockRouteContext({})
    );

    expect(response.status).toBe(500);
    expect(mocks.emitBatchPrioritySideEffects).not.toHaveBeenCalled();
  });
});
