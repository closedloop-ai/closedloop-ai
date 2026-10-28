/**
 * POST /documents/batch-delete/v2 (ISS-9464).
 *
 * The delete already commits partially, so the v2 work is the relabelling: v1's
 * `{ deletedIds, failedIds }` becomes one result per distinct requested id.
 */
import { randomUUID } from "node:crypto";
import { AuditActorType } from "@repo/api/src/types/audit";
import {
  BATCH_ITEM_APPLIED_STATUS,
  BatchItemFailureCode,
  batchItemFailed,
} from "@repo/api/src/types/batch-mutation-result";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { documentService } from "@/app/documents/document-service";
import type { AuthContext } from "@/lib/auth/with-auth";
import {
  createMockRequest,
  createMockRouteContext,
  createTestAuthContext,
} from "../utils/auth-helpers";

let mockAuthContext: AuthContext;

const mocks = vi.hoisted(() => ({ requiredScopes: [] as unknown[] }));

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
vi.mock("@/app/documents/document-service");

import { POST } from "@/app/documents/batch-delete/v2/route";

const DOC_A = "11111111-1111-4111-8111-111111111111";
const DOC_B = "22222222-2222-4222-8222-222222222222";
const MISSING_DOC = "99999999-9999-4999-8999-999999999999";

function makeRequest(documentIds: string[]) {
  return createMockRequest({
    url: "http://localhost:3002/documents/batch-delete/v2",
    method: "POST",
    body: { documentIds },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mockAuthContext = createTestAuthContext();
  vi.mocked(documentService.batchDelete).mockResolvedValue({
    deletedIds: [DOC_A],
    failedIds: [],
  });
});

describe("POST /documents/batch-delete/v2 (ISS-9464)", () => {
  it("is registered demanding the delete scope, like v1", () => {
    expect(mocks.requiredScopes).toEqual([["delete"]]);
  });

  it("returns a 400 envelope on an invalid body, before the service", async () => {
    const response = await POST(makeRequest([]), createMockRouteContext({}));

    expect(response.status).toBe(400);
    expect(documentService.batchDelete).not.toHaveBeenCalled();
  });

  it("reports the deleted ids applied and the rest not found, in first-appearance order", async () => {
    vi.mocked(documentService.batchDelete).mockResolvedValue({
      deletedIds: [DOC_A, DOC_B],
      failedIds: [MISSING_DOC],
    });

    const response = await POST(
      makeRequest([DOC_B, MISSING_DOC, DOC_A, DOC_B]),
      createMockRouteContext({})
    );

    expect(response.status).toBe(200);
    const json = await response.json();
    expect(json.data.results).toEqual([
      { id: DOC_B, status: BATCH_ITEM_APPLIED_STATUS },
      batchItemFailed(MISSING_DOC, BatchItemFailureCode.ArtifactsNotFound),
      { id: DOC_A, status: BATCH_ITEM_APPLIED_STATUS },
    ]);
  });

  it("passes the organization and the authenticated actor to the service, like v1", async () => {
    const ids = [randomUUID()];
    vi.mocked(documentService.batchDelete).mockResolvedValue({
      deletedIds: ids,
      failedIds: [],
    });

    await POST(makeRequest(ids), createMockRouteContext({}));

    // Every audit entry the batch enqueues is attributed to this actor
    // (ISS-10029); dropping it leaves a whole batch of deletes unattributed.
    expect(documentService.batchDelete).toHaveBeenCalledWith(
      ids,
      mockAuthContext.user.organizationId,
      { actorType: AuditActorType.User, actorId: mockAuthContext.user.id },
      expect.any(String),
      // ISS-12552: a session request records nothing, so the service gets
      // no recorder and deletes exactly as it did before receipts.
      undefined
    );
  });

  it("returns 500 when the service throws", async () => {
    vi.mocked(documentService.batchDelete).mockRejectedValue(
      new Error("Database connection failed")
    );

    const response = await POST(
      makeRequest([DOC_A]),
      createMockRouteContext({})
    );

    expect(response.status).toBe(500);
    const json = await response.json();
    expect(json.error).toBe("Failed to delete documents");
  });
});
