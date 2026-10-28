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
  batchSetArtifactFavorites: vi.fn(),
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
vi.mock("@/app/artifacts/favorites-batch-service", () => ({
  batchSetArtifactFavorites: mocks.batchSetArtifactFavorites,
}));

import { POST } from "@/app/artifacts/favorites/batch/v2/route";
import { MOCK_TRANSACTION_CLIENT } from "../utils/mock-with-db";

const DOCUMENT_ID = "11111111-1111-4111-8111-111111111111";
const BRANCH_ID = "22222222-2222-4222-8222-222222222222";
const MISSING_ID = "99999999-9999-4999-8999-999999999999";

function request(artifactIds: string[], favorite: boolean) {
  return createMockRequest({
    url: "http://localhost:3002/artifacts/favorites/batch/v2",
    method: "POST",
    body: { artifactIds, favorite },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mockAuthContext = createTestAuthContext();
  mocks.batchSetArtifactFavorites.mockResolvedValue(
    new Map([[DOCUMENT_ID, batchItemApplied(DOCUMENT_ID)]])
  );
});

describe("POST /artifacts/favorites/batch/v2", () => {
  it("registers the favorite write scope and refuses more than 500 IDs", async () => {
    expect(mocks.requiredScopes).toEqual([
      [ARTIFACT_BULK_ACTION_SCOPE[ArtifactBulkAction.ChangeFavorite]],
    ]);
    const ids = Array.from(
      { length: BATCH_MUTATION_ENTITY_LIMIT + 1 },
      (_unused, index) =>
        `11111111-1111-4111-8111-${index.toString(16).padStart(12, "0")}`
    );
    const response = await POST(request(ids, true), createMockRouteContext({}));
    expect(response.status).toBe(400);
    expect(mocks.batchSetArtifactFavorites).not.toHaveBeenCalled();
  });

  it("returns mixed artifact outcomes and one transaction receipt", async () => {
    mocks.batchSetArtifactFavorites.mockResolvedValue(
      new Map<string, BatchItemResult>([
        [DOCUMENT_ID, batchItemApplied(DOCUMENT_ID)],
        [BRANCH_ID, batchItemApplied(BRANCH_ID)],
        [
          MISSING_ID,
          batchItemFailed(MISSING_ID, BatchItemFailureCode.ArtifactsNotFound),
        ],
      ])
    );
    const response = await POST(
      request([BRANCH_ID, MISSING_ID, DOCUMENT_ID, BRANCH_ID], true),
      createMockRouteContext({})
    );
    const json = await response.json();
    expect(response.status).toBe(200);
    expect(json.data.results).toEqual([
      batchItemApplied(BRANCH_ID),
      batchItemFailed(MISSING_ID, BatchItemFailureCode.ArtifactsNotFound),
      batchItemApplied(DOCUMENT_ID),
    ]);
    expect(json.data.transactionId).toEqual(expect.any(String));
    expect(mocks.batchSetArtifactFavorites).toHaveBeenCalledWith(
      MOCK_TRANSACTION_CLIENT,
      [BRANCH_ID, MISSING_ID, DOCUMENT_ID, BRANCH_ID],
      mockAuthContext.user.id,
      mockAuthContext.user.organizationId,
      true,
      // A session caller gets no receipt, so no recorder.
      undefined
    );
  });

  it("passes a false target state to the write instead of toggling each row", async () => {
    await POST(request([DOCUMENT_ID], false), createMockRouteContext({}));
    expect(mocks.batchSetArtifactFavorites).toHaveBeenCalledWith(
      MOCK_TRANSACTION_CLIENT,
      [DOCUMENT_ID],
      mockAuthContext.user.id,
      mockAuthContext.user.organizationId,
      false,
      undefined
    );
  });
});
