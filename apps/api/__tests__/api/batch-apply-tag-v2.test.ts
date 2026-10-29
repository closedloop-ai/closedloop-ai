/**
 * POST /entity-tags/batch/v2 (ISS-9464).
 *
 * The service is covered by `__tests__/unit/batch-apply-tag-service.test.ts`.
 * This pins the route: the v1 scope, the v1 validator, and the split between a
 * per-item failure and the whole-batch 404 a missing tag still is.
 */
import {
  BATCH_ITEM_APPLIED_STATUS,
  BatchItemFailureCode,
  type BatchItemResult,
  batchItemApplied,
  batchItemFailed,
} from "@repo/api/src/types/batch-mutation-result";
import { Result, Status } from "@repo/api/src/types/result";
import { TagEntityType } from "@repo/api/src/types/tag";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AuthContext } from "@/lib/auth/with-auth";
import {
  createMockRequest,
  createMockRouteContext,
  createTestAuthContext,
} from "../utils/auth-helpers";

let mockAuthContext: AuthContext;

const mocks = vi.hoisted(() => ({
  applyPerItem: vi.fn(),
  captureBatchTagApplied: vi.fn(),
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
vi.mock("@/app/tags/batch-apply-tag-service", () => ({
  batchApplyTagService: { applyPerItem: mocks.applyPerItem },
}));
// The receipt store is the one thing behind this route that is not mocked
// otherwise, and since ISS-10993 the route awaits it inside its transaction.
vi.mock("@/lib/artifact-activity-capture", () => ({
  captureBatchTagApplied: (...args: unknown[]) =>
    mocks.captureBatchTagApplied(...args),
}));

import { POST } from "@/app/entity-tags/batch/v2/route";

const TAG_ID = "33333333-3333-4333-8333-333333333331";
const ARTIFACT_A = "55555555-5555-4555-8555-555555555551";
const ARTIFACT_B = "55555555-5555-4555-8555-555555555552";
const MISSING_ARTIFACT = "99999999-9999-4999-8999-999999999999";

function makeRequest(body: unknown) {
  return createMockRequest({
    url: "http://localhost:3002/entity-tags/batch/v2",
    method: "POST",
    body,
  });
}

function tagRequest(entityIds: string[]) {
  return makeRequest({
    tagId: TAG_ID,
    entityType: TagEntityType.Artifact,
    entityIds,
  });
}

function serviceReturns(...results: BatchItemResult[]) {
  mocks.applyPerItem.mockResolvedValue(
    Result.ok({
      results: new Map(results.map((result) => [result.id, result] as const)),
      newlyTaggedIds: results.map((result) => result.id),
    })
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  mockAuthContext = createTestAuthContext();
  serviceReturns(batchItemApplied(ARTIFACT_A));
});

describe("POST /entity-tags/batch/v2 (ISS-9464)", () => {
  it("is registered demanding the write scope, like v1", () => {
    expect(mocks.requiredScopes).toEqual([["write"]]);
  });

  it("returns a 400 envelope for a non-artifact entity type, before the service", async () => {
    const response = await POST(
      makeRequest({
        tagId: TAG_ID,
        entityType: TagEntityType.Project,
        entityIds: [ARTIFACT_A],
      }),
      createMockRouteContext({})
    );

    expect(response.status).toBe(400);
    expect(mocks.applyPerItem).not.toHaveBeenCalled();
  });

  it("maps a tag outside the caller's org to a 404 envelope", async () => {
    mocks.applyPerItem.mockResolvedValue(Result.err(Status.NotFound));

    const response = await POST(
      tagRequest([ARTIFACT_A]),
      createMockRouteContext({})
    );

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toMatchObject({ success: false });
  });

  it("answers 200 with one result per distinct id in first-appearance order", async () => {
    serviceReturns(
      batchItemApplied(ARTIFACT_A),
      batchItemApplied(ARTIFACT_B),
      batchItemFailed(MISSING_ARTIFACT, BatchItemFailureCode.ArtifactsNotFound)
    );

    const response = await POST(
      tagRequest([ARTIFACT_B, MISSING_ARTIFACT, ARTIFACT_A, ARTIFACT_B]),
      createMockRouteContext({})
    );

    expect(response.status).toBe(200);
    const json = await response.json();
    expect(json.data.results).toEqual([
      { id: ARTIFACT_B, status: BATCH_ITEM_APPLIED_STATUS },
      batchItemFailed(MISSING_ARTIFACT, BatchItemFailureCode.ArtifactsNotFound),
      { id: ARTIFACT_A, status: BATCH_ITEM_APPLIED_STATUS },
    ]);
    expect(mocks.applyPerItem).toHaveBeenCalledWith(
      TAG_ID,
      TagEntityType.Artifact,
      [ARTIFACT_B, MISSING_ARTIFACT, ARTIFACT_A, ARTIFACT_B],
      mockAuthContext.user.organizationId,
      // ISS-10993: the receipt writer the route hands the INSERT, so the write
      // owns the transaction both commit on and the service's post-commit
      // GitHub label reconciliation stays outside it.
      expect.any(Function)
    );
  });

  it("returns 500 when the service rejects", async () => {
    mocks.applyPerItem.mockRejectedValue(new Error("connection reset"));

    const response = await POST(
      tagRequest([ARTIFACT_A]),
      createMockRouteContext({})
    );

    expect(response.status).toBe(500);
    const json = await response.json();
    expect(json.error).toBe("Failed to apply tags");
  });
});
