/**
 * POST /documents/batch-move/v2 (ISS-9464).
 *
 * The service is covered by `app/documents/__tests__/document-batch-move-service.test.ts`.
 * This pins the route's own contract: the `withAnyAuth` wrapper v1 uses
 * (ISS-11409), the per-item envelope, and activity capture over the rows that
 * committed.
 */
import {
  BATCH_ITEM_APPLIED_STATUS,
  BatchItemFailureCode,
  type BatchItemResult,
  batchItemApplied,
  batchItemFailed,
} from "@repo/api/src/types/batch-mutation-result";
import { Result, Status } from "@repo/api/src/types/result";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MOCK_TRANSACTION_CLIENT } from "@/__tests__/utils/mock-with-db";
import type { AuthContext } from "@/lib/auth/with-auth";
import {
  createMockRequest,
  createMockRouteContext,
  createTestAuthContext,
} from "../utils/auth-helpers";

let mockAuthContext: AuthContext;

const mocks = vi.hoisted(() => ({
  batchMovePerItem: vi.fn(),
  captureBatchProjectChange: vi.fn(),
  dispatchAuditEvents: vi.fn(),
  wrappedWithAnyAuth: false,
  wrappedWithAuth: false,
}));

// ISS-10993: the route opens ONE transaction for the mutation and its activity
// receipt. Every store this suite reaches is mocked, so the real `withDb` would
// only add a Postgres the unit lane does not have.
vi.mock("@repo/database", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  withDb: (await import("@/__tests__/utils/mock-with-db")).mockWithDb(),
}));

vi.mock("@/lib/auth/with-auth", () => ({
  withAuth: (handler: (...args: unknown[]) => Promise<Response>) => {
    mocks.wrappedWithAuth = true;
    return (request: unknown, context?: { params: Promise<unknown> }) =>
      handler(mockAuthContext, request, context?.params);
  },
}));
vi.mock("@/lib/auth/with-any-auth", () => ({
  withAnyAuth: (handler: (...args: unknown[]) => Promise<Response>) => {
    mocks.wrappedWithAnyAuth = true;
    return (request: unknown, context?: { params: Promise<unknown> }) =>
      handler(mockAuthContext, request, context?.params);
  },
}));
vi.mock("@/app/documents/document-batch-move-service", () => ({
  documentBatchMoveService: { batchMovePerItem: mocks.batchMovePerItem },
}));
vi.mock("@/lib/artifact-activity-capture", () => ({
  captureBatchProjectChange: (...args: unknown[]) =>
    mocks.captureBatchProjectChange(...args),
}));
vi.mock("@/app/audit/audit-emit-service", () => ({
  dispatchAuditEvents: (...args: unknown[]) =>
    mocks.dispatchAuditEvents(...args),
  userAuditActor: (userId: string) => ({ actorType: "user", actorId: userId }),
}));

import { POST } from "@/app/documents/batch-move/v2/route";

const DOC_A = "11111111-1111-4111-8111-111111111111";
const DOC_B = "22222222-2222-4222-8222-222222222222";
const MISSING_DOC = "99999999-9999-4999-8999-999999999999";
const SOURCE_PROJECT_ID = "33333333-3333-4333-8333-333333333333";
const TARGET_PROJECT_ID = "44444444-4444-4444-8444-444444444444";

function makeRequest(body: unknown) {
  return createMockRequest({
    url: "http://localhost:3002/documents/batch-move/v2",
    method: "POST",
    body,
  });
}

function moveRequest(documentIds: string[]) {
  return makeRequest({ documentIds, targetProjectId: TARGET_PROJECT_ID });
}

function serviceReturns(
  results: BatchItemResult[],
  projectChanges: Array<{
    artifactId: string;
    before: string | null;
    after: string;
  }> = []
) {
  mocks.batchMovePerItem.mockResolvedValue(
    Result.ok({
      results: new Map(results.map((result) => [result.id, result] as const)),
      projectChanges,
    })
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  mockAuthContext = createTestAuthContext();
  serviceReturns([batchItemApplied(DOC_A)]);
});

describe("POST /documents/batch-move/v2 (ISS-9464)", () => {
  it("is mounted on withAnyAuth, as v1 is, not the session-only withAuth", () => {
    expect(mocks.wrappedWithAnyAuth).toBe(true);
    expect(mocks.wrappedWithAuth).toBe(false);
  });

  it("returns a 400 envelope on an invalid body, before the service", async () => {
    const response = await POST(moveRequest([]), createMockRouteContext({}));

    expect(response.status).toBe(400);
    expect(mocks.batchMovePerItem).not.toHaveBeenCalled();
    expect(mocks.captureBatchProjectChange).not.toHaveBeenCalled();
  });

  it("maps a target project outside the org to a 400 envelope, capturing nothing", async () => {
    mocks.batchMovePerItem.mockResolvedValue(Result.err(Status.BadRequest));

    const response = await POST(
      moveRequest([DOC_A]),
      createMockRouteContext({})
    );

    expect(response.status).toBe(400);
    expect(mocks.captureBatchProjectChange).not.toHaveBeenCalled();
  });

  it("answers 200 with one result per distinct id in first-appearance order", async () => {
    serviceReturns([
      batchItemApplied(DOC_A),
      batchItemApplied(DOC_B),
      batchItemFailed(MISSING_DOC, BatchItemFailureCode.ArtifactsNotFound),
    ]);

    const response = await POST(
      moveRequest([DOC_B, MISSING_DOC, DOC_A, DOC_B]),
      createMockRouteContext({})
    );

    expect(response.status).toBe(200);
    const json = await response.json();
    expect(json.data.results).toEqual([
      { id: DOC_B, status: BATCH_ITEM_APPLIED_STATUS },
      batchItemFailed(MISSING_DOC, BatchItemFailureCode.ArtifactsNotFound),
      { id: DOC_A, status: BATCH_ITEM_APPLIED_STATUS },
    ]);
    expect(mocks.batchMovePerItem).toHaveBeenCalledWith(
      [DOC_B, MISSING_DOC, DOC_A, DOC_B],
      TARGET_PROJECT_ID,
      mockAuthContext.user.organizationId
    );
  });

  it("captures a project change for the rows that moved, never the requested ids", async () => {
    const projectChanges = [
      {
        artifactId: DOC_A,
        before: SOURCE_PROJECT_ID,
        after: TARGET_PROJECT_ID,
      },
    ];
    serviceReturns(
      [
        batchItemApplied(DOC_A),
        batchItemFailed(MISSING_DOC, BatchItemFailureCode.ArtifactsNotFound),
      ],
      projectChanges
    );

    await POST(moveRequest([DOC_A, MISSING_DOC]), createMockRouteContext({}));

    expect(mocks.captureBatchProjectChange).toHaveBeenCalledTimes(1);
    expect(mocks.captureBatchProjectChange).toHaveBeenCalledWith({
      tx: MOCK_TRANSACTION_CLIENT,
      organizationId: mockAuthContext.user.organizationId,
      actor: {
        userId: mockAuthContext.user.id,
        authMethod: mockAuthContext.authMethod,
      },
      changes: projectChanges,
      transactionId: expect.any(String),
      provenance: undefined,
      preserveProvenanceOmission: true,
    });

    // ISS-9465 ruling 6, and ruling 4: the ledger entry, the receipt and the
    // response body all name one commit. Literals for the vocabulary, because a
    // ledger value is hashed into a chain and can never be renamed.
    const [auditEvents] = mocks.dispatchAuditEvents.mock.calls[0];
    expect(auditEvents).toEqual([
      expect.objectContaining({
        action: "artifact.project_changed",
        objectType: "artifact",
        objectId: DOC_A,
      }),
    ]);
    expect(auditEvents[0].detail.transactionId).toBe(
      mocks.captureBatchProjectChange.mock.calls[0][0].transactionId
    );
  });

  /**
   * ISS-10993, operator ruling (Cosimo Corrigan, 2026-09-23). This case asserted
   * the OPPOSITE until that ruling: a capture failure was swallowed and the move
   * still answered 200, which is how a defect eroded the published activity feed
   * for an unknown period with nobody able to see it. The receipt now commits
   * with the move, so a capture that cannot record REFUSES the move.
   *
   * The counterfactual is the swallow itself: restore a `catch {}` around the
   * capture and this goes back to 200 and fails.
   */
  it("refuses the move when the capture cannot record its receipt", async () => {
    mocks.captureBatchProjectChange.mockRejectedValue(
      new Error("activity store down")
    );
    serviceReturns(
      [batchItemApplied(DOC_A)],
      [
        {
          artifactId: DOC_A,
          before: SOURCE_PROJECT_ID,
          after: TARGET_PROJECT_ID,
        },
      ]
    );

    const response = await POST(
      moveRequest([DOC_A]),
      createMockRouteContext({})
    );

    expect(response.status).toBe(500);
    // The ledger emission is post-commit, so a refused move must not have
    // written one: an audit entry for a move that rolled back is a forged row.
    expect(mocks.dispatchAuditEvents).not.toHaveBeenCalled();
  });

  it("returns 500 when the service rejects", async () => {
    mocks.batchMovePerItem.mockRejectedValue(new Error("connection reset"));

    const response = await POST(
      moveRequest([DOC_A]),
      createMockRouteContext({})
    );

    expect(response.status).toBe(500);
    expect(mocks.captureBatchProjectChange).not.toHaveBeenCalled();
  });
});
