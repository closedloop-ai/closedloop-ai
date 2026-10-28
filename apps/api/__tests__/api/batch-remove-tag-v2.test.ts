/**
 * POST /entity-tags/batch-remove/v2 (ISS-10686).
 *
 * The service is covered by `__tests__/unit/batch-remove-tag-service.test.ts` —
 * including the org predicate, which is only decidable there. This pins the
 * route: the scope it demands, the validator it shares with its apply sibling,
 * which refusal maps to which envelope, and that the receipts are driven off the
 * ids the delete actually removed rather than the ids the caller named.
 */

import {
  ARTIFACT_BULK_ACTION_SCOPE,
  ArtifactBulkAction,
} from "@repo/api/src/types/artifact-bulk-action";
import { AuditAction } from "@repo/api/src/types/audit";
import { BATCH_MUTATION_ENTITY_LIMIT } from "@repo/api/src/types/batch-mutation-limits";
import {
  BATCH_ITEM_APPLIED_STATUS,
  BatchItemAppliedOutcome,
  batchItemAppliedWithOutcome,
} from "@repo/api/src/types/batch-mutation-result";
import { Result } from "@repo/api/src/types/result";
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
  removePerItem: vi.fn(),
  captureBatchTagActivity: vi.fn(),
  emitBatchTagSideEffects: vi.fn(),
  requiredScopes: [] as unknown[],
}));

vi.mock("@/lib/auth/with-any-auth", () => ({
  withAnyAuth: (
    handler: (...args: unknown[]) => Promise<Response>,
    options?: { requiredScopes?: unknown }
  ) => {
    mocks.requiredScopes.push(options?.requiredScopes);
    return (request: unknown, context: { params?: unknown }) =>
      handler(mockAuthContext, request, context.params);
  },
}));
vi.mock("@/app/tags/batch-tag-side-effects", () => ({
  captureBatchTagActivity: mocks.captureBatchTagActivity,
  emitBatchTagSideEffects: mocks.emitBatchTagSideEffects,
}));

import { POST } from "@/app/entity-tags/batch-remove/v2/route";
import {
  BatchRemoveTagRefusal,
  batchRemoveTagService,
} from "@/app/tags/batch-remove-tag-service";

const TAG_ID = "33333333-3333-4333-8333-333333333331";
/** Top-level per `useTopLevelRegex`. */
const ANOTHER_ORGANIZATION = /another organization/i;
const CARRYING_A = "55555555-5555-4555-8555-555555555551";
const CARRYING_B = "55555555-5555-4555-8555-555555555552";
const BARE_C = "55555555-5555-4555-8555-555555555553";

function makeRequest(body: unknown) {
  return createMockRequest({
    url: "http://localhost:3002/entity-tags/batch-remove/v2",
    method: "POST",
    body,
  });
}

function removeRequest(entityIds: string[]) {
  return makeRequest({
    tagId: TAG_ID,
    entityType: TagEntityType.Artifact,
    entityIds,
  });
}

function serviceRemoved(removedIds: string[], notPresentIds: string[] = []) {
  const results = new Map(
    [
      ...removedIds.map((id) =>
        batchItemAppliedWithOutcome(id, BatchItemAppliedOutcome.Removed)
      ),
      ...notPresentIds.map((id) =>
        batchItemAppliedWithOutcome(id, BatchItemAppliedOutcome.NotPresent)
      ),
    ].map((result) => [result.id, result] as const)
  );
  mocks.removePerItem.mockResolvedValue(Result.ok({ results, removedIds }));
}

beforeEach(() => {
  vi.clearAllMocks();
  mockAuthContext = createTestAuthContext();
  // Spied rather than module-mocked, so the route's real import is the thing
  // under test and the service module itself stays loadable.
  mocks.removePerItem = vi.spyOn(batchRemoveTagService, "removePerItem");
  serviceRemoved([CARRYING_A]);
});

describe("POST /entity-tags/batch-remove/v2 (ISS-10686)", () => {
  it("uses the canonical bulk Remove Tag scope", () => {
    expect(mocks.requiredScopes).toEqual([
      [ARTIFACT_BULK_ACTION_SCOPE[ArtifactBulkAction.RemoveTag]],
    ]);
  });

  it("returns a 400 envelope for a non-artifact entity type, before the service", async () => {
    const response = await POST(
      makeRequest({
        tagId: TAG_ID,
        entityType: TagEntityType.Project,
        entityIds: [CARRYING_A],
      }),
      createMockRouteContext({})
    );

    expect(response.status).toBe(400);
    expect(mocks.removePerItem).not.toHaveBeenCalled();
    expect(mocks.emitBatchTagSideEffects).not.toHaveBeenCalled();
  });

  it("rejects more than 500 artifacts before calling the service", async () => {
    const entityIds = Array.from(
      { length: BATCH_MUTATION_ENTITY_LIMIT + 1 },
      (_unused, index) =>
        `55555555-5555-4555-8555-${index.toString(16).padStart(12, "0")}`
    );

    const response = await POST(
      removeRequest(entityIds),
      createMockRouteContext({})
    );

    expect(response.status).toBe(400);
    expect(mocks.removePerItem).not.toHaveBeenCalled();
  });

  it("answers 200 carrying each id's own outcome, in first-appearance order", async () => {
    serviceRemoved([CARRYING_B, CARRYING_A], [BARE_C]);

    const response = await POST(
      removeRequest([CARRYING_B, BARE_C, CARRYING_A, CARRYING_B]),
      createMockRouteContext({})
    );

    expect(response.status).toBe(200);
    const json = await response.json();
    expect(json.data.results).toEqual([
      {
        id: CARRYING_B,
        status: BATCH_ITEM_APPLIED_STATUS,
        outcome: BatchItemAppliedOutcome.Removed,
      },
      {
        id: BARE_C,
        status: BATCH_ITEM_APPLIED_STATUS,
        outcome: BatchItemAppliedOutcome.NotPresent,
      },
      {
        id: CARRYING_A,
        status: BATCH_ITEM_APPLIED_STATUS,
        outcome: BatchItemAppliedOutcome.Removed,
      },
    ]);
    // The distinction survives serialization, which is the whole point of the
    // ruling: two removals and one no-op, never one count of three.
    expect(
      json.data.results.filter(
        (item: { outcome?: string }) =>
          item.outcome === BatchItemAppliedOutcome.Removed
      )
    ).toHaveLength(2);
    expect(mocks.removePerItem).toHaveBeenCalledWith(
      TAG_ID,
      TagEntityType.Artifact,
      [CARRYING_B, BARE_C, CARRYING_A, CARRYING_B],
      mockAuthContext.user.organizationId,
      expect.any(Function)
    );

    const receipt = mocks.removePerItem.mock.calls[0]?.[4];
    const tx = {};
    await receipt(
      tx,
      [CARRYING_B, CARRYING_A],
      [CARRYING_B, BARE_C, CARRYING_A]
    );
    expect(mocks.captureBatchTagActivity).toHaveBeenCalledWith(
      tx,
      expect.objectContaining({
        action: AuditAction.ArtifactTagRemoved,
        changedIds: [CARRYING_B, CARRYING_A],
        tagId: TAG_ID,
      })
    );
  });

  it("normalizes UUID casing before service dedupe and response ordering", async () => {
    serviceRemoved([CARRYING_A]);

    const response = await POST(
      makeRequest({
        tagId: TAG_ID.toUpperCase(),
        entityType: TagEntityType.Artifact,
        entityIds: [CARRYING_A.toUpperCase(), CARRYING_A],
      }),
      createMockRouteContext({})
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      data: {
        results: [
          {
            id: CARRYING_A,
            status: BATCH_ITEM_APPLIED_STATUS,
            outcome: BatchItemAppliedOutcome.Removed,
          },
        ],
      },
    });
    expect(mocks.removePerItem).toHaveBeenCalledWith(
      TAG_ID,
      TagEntityType.Artifact,
      [CARRYING_A, CARRYING_A],
      mockAuthContext.user.organizationId,
      expect.any(Function)
    );
  });

  it("fires the receipts for the ids that lost the tag, not the ids requested", async () => {
    serviceRemoved([CARRYING_A], [BARE_C]);

    const response = await POST(
      removeRequest([CARRYING_A, BARE_C]),
      createMockRouteContext({})
    );
    const json = await response.json();

    expect(mocks.emitBatchTagSideEffects).toHaveBeenCalledWith(
      expect.objectContaining({
        action: AuditAction.ArtifactTagRemoved,
        tagId: TAG_ID,
        changedIds: [CARRYING_A],
        transactionId: json.data.transactionId,
      })
    );
  });

  it("emits no receipt when the batch removed nothing", async () => {
    serviceRemoved([], [BARE_C]);

    const response = await POST(
      removeRequest([BARE_C]),
      createMockRouteContext({})
    );

    // Still a 200 with a per-item `unchanged` — a no-op is a success — and the
    // side-effect call still made, because it owns the empty-set short-circuit.
    expect(response.status).toBe(200);
    expect(mocks.emitBatchTagSideEffects).toHaveBeenCalledWith(
      expect.objectContaining({ changedIds: [] })
    );
  });

  it("maps a tag outside the caller's org to a 404 envelope", async () => {
    mocks.removePerItem.mockResolvedValue(
      Result.err(BatchRemoveTagRefusal.TagNotFound)
    );

    const response = await POST(
      removeRequest([CARRYING_A]),
      createMockRouteContext({})
    );

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toMatchObject({
      success: false,
      error: "Tag not found",
    });
    expect(mocks.emitBatchTagSideEffects).not.toHaveBeenCalled();
  });

  it("maps an unresolvable id to a 404 that names no id and claims no other org", async () => {
    mocks.removePerItem.mockResolvedValue(
      Result.err(BatchRemoveTagRefusal.UnresolvedIds)
    );

    const response = await POST(
      removeRequest([CARRYING_A, BARE_C]),
      createMockRouteContext({})
    );

    expect(response.status).toBe(404);
    const json = await response.json();
    expect(json.success).toBe(false);
    // R11: no id echoed back, and no claim about another organization — the
    // read behind it cannot see one, and saying so would be an enumeration
    // oracle. Distinct from the tag 404 above, which the previous case pins.
    expect(json.error).not.toContain(CARRYING_A);
    expect(json.error).not.toContain(BARE_C);
    expect(json.error).not.toMatch(ANOTHER_ORGANIZATION);
    expect(json.error).not.toBe("Tag not found");
    expect(mocks.emitBatchTagSideEffects).not.toHaveBeenCalled();
  });

  it("returns 500 when the service rejects", async () => {
    mocks.removePerItem.mockRejectedValue(new Error("connection reset"));

    const response = await POST(
      removeRequest([CARRYING_A]),
      createMockRouteContext({})
    );

    expect(response.status).toBe(500);
    const json = await response.json();
    expect(json.error).toBe("Failed to remove tags");
    expect(mocks.emitBatchTagSideEffects).not.toHaveBeenCalled();
  });
});
