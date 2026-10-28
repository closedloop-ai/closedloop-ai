import {
  ARTIFACT_BULK_ACTION_SCOPE,
  ArtifactBulkAction,
} from "@repo/api/src/types/artifact-bulk-action";
import { BATCH_MUTATION_ENTITY_LIMIT } from "@repo/api/src/types/batch-mutation-limits";
import {
  BatchItemFailureCode,
  type BatchItemResult,
  batchItemApplied,
  batchItemFailed,
} from "@repo/api/src/types/batch-mutation-result";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AuthContext } from "@/lib/auth/with-auth";
import {
  createMockRequest,
  createMockRouteContext,
  createTestAuthContext,
} from "../utils/auth-helpers";

let mockAuthContext: AuthContext;
const mocks = vi.hoisted(() => ({
  batchUpdateDocumentAssignee: vi.fn(),
  captureBatchAssigneeAssignment: vi.fn(),
  emitBatchDocumentAssigneeSideEffects: vi.fn(),
  requiredScopes: [] as unknown[],
}));

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
vi.mock("@/app/documents/document-assignee-batch-item-service", () => ({
  batchUpdateDocumentAssignee: mocks.batchUpdateDocumentAssignee,
}));
vi.mock("@/app/documents/document-assignee-batch-side-effects", () => ({
  emitBatchDocumentAssigneeSideEffects:
    mocks.emitBatchDocumentAssigneeSideEffects,
}));
vi.mock("@/lib/artifact-activity-capture", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  captureBatchAssigneeAssignment: mocks.captureBatchAssigneeAssignment,
}));

import { POST } from "@/app/documents/batch-update-assignee/v2/route";
import { MOCK_TRANSACTION_CLIENT } from "../utils/mock-with-db";

const DOCUMENT_ID = "11111111-1111-4111-8111-111111111111";
const ISSUE_ID = "22222222-2222-4222-8222-222222222222";
const MISSING_ID = "99999999-9999-4999-8999-999999999999";
const OWNER_ID = "33333333-3333-4333-8333-333333333333";

function request(documentIds: string[], assigneeId: string | null = OWNER_ID) {
  return createMockRequest({
    url: "http://localhost:3002/documents/batch-update-assignee/v2",
    method: "POST",
    body: { documentIds, assigneeId },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mockAuthContext = createTestAuthContext();
  mocks.batchUpdateDocumentAssignee.mockResolvedValue({
    validAssignee: true,
    resultsById: new Map([[DOCUMENT_ID, batchItemApplied(DOCUMENT_ID)]]),
    changes: [],
  });
});

describe("POST /documents/batch-update-assignee/v2", () => {
  it("registers the owner write scope and rejects more than 500 IDs", async () => {
    expect(mocks.requiredScopes).toEqual([
      [ARTIFACT_BULK_ACTION_SCOPE[ArtifactBulkAction.ChangeOwner]],
    ]);
    const ids = Array.from(
      { length: BATCH_MUTATION_ENTITY_LIMIT + 1 },
      (_unused, index) =>
        `11111111-1111-4111-8111-${index.toString(16).padStart(12, "0")}`
    );
    const response = await POST(request(ids), createMockRouteContext({}));
    expect(response.status).toBe(400);
    expect(mocks.batchUpdateDocumentAssignee).not.toHaveBeenCalled();
  });

  it("returns ordered per-item outcomes and captures only committed changes in the same transaction", async () => {
    const changes = [{ artifactId: ISSUE_ID, before: null, after: OWNER_ID }];
    mocks.batchUpdateDocumentAssignee.mockResolvedValue({
      validAssignee: true,
      resultsById: new Map<string, BatchItemResult>([
        [DOCUMENT_ID, batchItemApplied(DOCUMENT_ID)],
        [ISSUE_ID, batchItemApplied(ISSUE_ID)],
        [
          MISSING_ID,
          batchItemFailed(MISSING_ID, BatchItemFailureCode.ArtifactsNotFound),
        ],
      ]),
      changes,
    });
    const response = await POST(
      request([ISSUE_ID, MISSING_ID, DOCUMENT_ID, ISSUE_ID]),
      createMockRouteContext({})
    );
    const json = await response.json();
    expect(response.status).toBe(200);
    expect(json.data.results).toEqual([
      batchItemApplied(ISSUE_ID),
      batchItemFailed(MISSING_ID, BatchItemFailureCode.ArtifactsNotFound),
      batchItemApplied(DOCUMENT_ID),
    ]);
    expect(json.data.transactionId).toEqual(expect.any(String));
    expect(mocks.batchUpdateDocumentAssignee).toHaveBeenCalledWith(
      MOCK_TRANSACTION_CLIENT,
      [ISSUE_ID, MISSING_ID, DOCUMENT_ID, ISSUE_ID],
      OWNER_ID,
      mockAuthContext.user.organizationId
    );
    expect(mocks.captureBatchAssigneeAssignment).toHaveBeenCalledWith({
      tx: MOCK_TRANSACTION_CLIENT,
      organizationId: mockAuthContext.user.organizationId,
      changes,
      actor: {
        userId: mockAuthContext.user.id,
        authMethod: mockAuthContext.authMethod,
      },
      transactionId: json.data.transactionId,
    });
    expect(mocks.emitBatchDocumentAssigneeSideEffects).toHaveBeenCalledWith({
      actorUserId: mockAuthContext.user.id,
      organizationId: mockAuthContext.user.organizationId,
      assigneeId: OWNER_ID,
      changes,
    });
  });

  it("refuses an out-of-org owner before recording a receipt", async () => {
    mocks.batchUpdateDocumentAssignee.mockResolvedValue({
      validAssignee: false,
      resultsById: new Map(),
      changes: [],
    });
    const response = await POST(
      request([DOCUMENT_ID]),
      createMockRouteContext({})
    );
    expect(response.status).toBe(400);
    expect(mocks.captureBatchAssigneeAssignment).not.toHaveBeenCalled();
    expect(mocks.emitBatchDocumentAssigneeSideEffects).not.toHaveBeenCalled();
  });
});
