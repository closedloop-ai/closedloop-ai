/**
 * POST /documents/batch-update-status/v2 (ISS-9464).
 *
 * The service is covered by
 * `app/documents/__tests__/document-status-batch-item-service.test.ts`. This
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
import { IssueStatus } from "@repo/api/src/types/document";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AuthContext } from "@/lib/auth/with-auth";
import {
  createMockRequest,
  createMockRouteContext,
  createTestAuthContext,
} from "../utils/auth-helpers";

let mockAuthContext: AuthContext;

const mocks = vi.hoisted(() => ({
  captureBatchStatusActivity: vi.fn(),
  batchUpdateStatus: vi.fn(),
  emitBatchStatusSideEffects: vi.fn(),
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
vi.mock("@/app/documents/document-status-batch-item-service", () => ({
  documentStatusBatchItemService: {
    batchUpdateStatus: mocks.batchUpdateStatus,
  },
}));
vi.mock("@/app/documents/batch-status-side-effects", () => ({
  captureBatchStatusActivity: (...args: unknown[]) =>
    mocks.captureBatchStatusActivity(...args),
  emitBatchStatusSideEffects: (...args: unknown[]) =>
    mocks.emitBatchStatusSideEffects(...args),
}));
vi.mock(
  "@/app/documents/batch-field-edit-refusal-analytics",
  async (importOriginal) => ({
    ...(await importOriginal<object>()),
    emitBatchItemFieldEditRefusalAnalytics:
      mocks.emitBatchItemFieldEditRefusalAnalytics,
  })
);

import { POST } from "@/app/documents/batch-update-status/v2/route";

const DOC_A = "11111111-1111-4111-8111-111111111111";
const DOC_B = "22222222-2222-4222-8222-222222222222";
const STALE_DOC = "99999999-9999-4999-8999-999999999999";

function statusRequest(documentIds: string[], surface?: string) {
  return createMockRequest({
    url: "http://localhost:3002/documents/batch-update-status/v2",
    method: "POST",
    body: {
      documentIds,
      status: IssueStatus.Done,
      ...(surface === undefined ? {} : { surface }),
    },
  });
}

function serviceReturns(
  results: BatchItemResult[],
  changedIds: string[] = [],
  transitions: Array<{ documentId: string; before: string; after: string }> = []
) {
  mocks.batchUpdateStatus.mockResolvedValue({
    resultsById: new Map(results.map((result) => [result.id, result] as const)),
    changedIds,
    transitions,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mockAuthContext = createTestAuthContext();
  serviceReturns([batchItemApplied(DOC_A)]);
});

describe("POST /documents/batch-update-status/v2 (ISS-9464)", () => {
  it("is registered demanding the write scope", () => {
    // Length first: an empty array would satisfy a `toEqual` against nothing,
    // which is what a route that stopped declaring scopes would produce.
    expect(mocks.requiredScopes).toHaveLength(1);
    expect(mocks.requiredScopes).toEqual([["write"]]);
  });

  it("returns a 400 envelope on an invalid body, before the service", async () => {
    const response = await POST(statusRequest([]), createMockRouteContext({}));

    expect(response.status).toBe(400);
    expect(mocks.batchUpdateStatus).not.toHaveBeenCalled();
    expect(mocks.emitBatchStatusSideEffects).not.toHaveBeenCalled();
  });

  it("commits an unknown future surface without receipt or analytics provenance", async () => {
    const transitions = [
      {
        documentId: DOC_A,
        before: IssueStatus.InProgress,
        after: IssueStatus.Done,
      },
    ];
    serviceReturns([batchItemApplied(DOC_A)], [DOC_A], transitions);

    const response = await POST(
      statusRequest([DOC_A], "command_palette"),
      createMockRouteContext({})
    );

    expect(response.status).toBe(200);
    expect(mocks.batchUpdateStatus).toHaveBeenCalledTimes(1);
    expect(mocks.captureBatchStatusActivity).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ surface: undefined, transitions })
    );
    expect(mocks.emitBatchStatusSideEffects).toHaveBeenCalledWith(
      expect.objectContaining({ surface: undefined, transitions })
    );
    expect(mocks.emitBatchItemFieldEditRefusalAnalytics).toHaveBeenCalledWith(
      expect.objectContaining({ surface: undefined })
    );
  });

  it("answers 200 with one result per distinct id in first-appearance order", async () => {
    serviceReturns([
      batchItemApplied(DOC_A),
      batchItemApplied(DOC_B),
      batchItemFailed(STALE_DOC, BatchItemFailureCode.StaleStatus),
    ]);

    const response = await POST(
      statusRequest([DOC_B, STALE_DOC, DOC_A, DOC_B]),
      createMockRouteContext({})
    );

    expect(response.status).toBe(200);
    const json = await response.json();
    expect(json.data.results).toEqual([
      { id: DOC_B, status: BATCH_ITEM_APPLIED_STATUS },
      batchItemFailed(STALE_DOC, BatchItemFailureCode.StaleStatus),
      { id: DOC_A, status: BATCH_ITEM_APPLIED_STATUS },
    ]);
    expect(mocks.batchUpdateStatus).toHaveBeenCalledWith(
      [DOC_B, STALE_DOC, DOC_A, DOC_B],
      IssueStatus.Done,
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
      batchItemFailed(STALE_DOC, BatchItemFailureCode.StaleStatus),
    ]);
  });

  it("forwards the caller's expected statuses to the service", async () => {
    const expectedStatusById = { [DOC_A]: IssueStatus.InProgress };

    await POST(
      createMockRequest({
        url: "http://localhost:3002/documents/batch-update-status/v2",
        method: "POST",
        body: {
          documentIds: [DOC_A],
          status: IssueStatus.Done,
          expectedStatusById,
        },
      }),
      createMockRouteContext({})
    );

    // Every other case here sends no expectation and asserts `undefined` in
    // this slot, so a route that dropped the field would keep them all green
    // while the optimistic-concurrency guard was silently off for v2.
    expect(mocks.batchUpdateStatus).toHaveBeenCalledWith(
      [DOC_A],
      IssueStatus.Done,
      mockAuthContext.user.organizationId,
      expectedStatusById
    );
  });

  it("emits side effects for the committed subset, never the requested ids", async () => {
    const transitions = [
      {
        documentId: DOC_A,
        before: IssueStatus.InProgress,
        after: IssueStatus.Done,
      },
    ];
    serviceReturns(
      [
        batchItemApplied(DOC_A),
        batchItemFailed(STALE_DOC, BatchItemFailureCode.StaleStatus),
      ],
      [DOC_A],
      transitions
    );

    const response = await POST(
      statusRequest([DOC_A, STALE_DOC], ArtifactStatusEditSurface.Bulk),
      createMockRouteContext({})
    );

    expect(mocks.emitBatchStatusSideEffects).toHaveBeenCalledTimes(1);
    expect(mocks.emitBatchStatusSideEffects).toHaveBeenCalledWith({
      user: mockAuthContext.user,
      authMethod: mockAuthContext.authMethod,
      status: IssueStatus.Done,
      surface: ArtifactStatusEditSurface.Bulk,
      transitions,
      changedIds: [DOC_A],
      transactionId: expect.any(String),
      reportNoChange: false,
    });
    // ISS-9465 ruling 4: the id the side effects were given is the one the
    // caller is handed back, so a client can name the group the server wrote.
    const emitted = mocks.emitBatchStatusSideEffects.mock.calls[0][0];
    const json = await response.json();
    expect(json.data.transactionId).toBe(emitted.transactionId);
  });

  it("does not add no-change analytics when every item is refused", async () => {
    serviceReturns([
      batchItemFailed(STALE_DOC, BatchItemFailureCode.StaleStatus),
    ]);

    await POST(statusRequest([STALE_DOC]), createMockRouteContext({}));

    expect(mocks.emitBatchStatusSideEffects).toHaveBeenCalledWith(
      expect.objectContaining({ reportNoChange: false })
    );
  });

  it("returns 500 when the service rejects, emitting nothing", async () => {
    mocks.batchUpdateStatus.mockRejectedValue(new Error("connection reset"));

    const response = await POST(
      statusRequest([DOC_A]),
      createMockRouteContext({})
    );

    expect(response.status).toBe(500);
    expect(mocks.emitBatchStatusSideEffects).not.toHaveBeenCalled();
  });
});
