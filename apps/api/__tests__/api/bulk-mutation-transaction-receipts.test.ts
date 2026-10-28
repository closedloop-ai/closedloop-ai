/**
 * ISS-9465 — one transaction identity per bulk mutation, carried in three
 * places.
 *
 * Entered at the ROUTE and run through the real side-effect modules, with only
 * the domain service, the audit outbox and the activity store faked. The
 * contract under test is the wiring between those layers: a unit test of either
 * emitter would stay green if a route stopped calling it.
 *
 * TWO routes, deliberately. Ruling 6 is a PER-ROUTE contract and ruling 3 a
 * PER-TABLE one, and a single-route fixture cannot tell a per-route
 * implementation from one global id shared by every batch the process serves —
 * it passes under exactly the mutation these cases exist to catch.
 */
import { AuditActorType } from "@repo/api/src/types/audit";
import {
  type BatchItemResult,
  batchItemApplied,
} from "@repo/api/src/types/batch-mutation-result";
import { Priority } from "@repo/api/src/types/common";
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
  batchUpdatePriorityPerItem: vi.fn(),
  applyPerItem: vi.fn(),
  dispatchAuditEvents: vi.fn(),
  captureBatchPriorityChange: vi.fn(),
  captureBatchTagApplied: vi.fn(),
}));

// ISS-10993: the route opens ONE transaction for the mutation and its activity
// receipt. Every store this suite reaches is mocked, so the real `withDb` would
// only add a Postgres the unit lane does not have.
vi.mock("@repo/database", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  withDb: (await import("@/__tests__/utils/mock-with-db")).mockWithDb(),
}));

vi.mock("@/lib/auth/with-any-auth", () => ({
  withAnyAuth: (handler: (...args: unknown[]) => Promise<Response>) => {
    return (request: unknown, context?: { params: Promise<unknown> }) =>
      handler(mockAuthContext, request, context?.params);
  },
}));
vi.mock("@/app/documents/artifact-bulk-priority-service", () => ({
  artifactBulkPriorityService: {
    batchUpdatePriorityPerItem: mocks.batchUpdatePriorityPerItem,
  },
}));
vi.mock("@/app/tags/batch-apply-tag-service", () => ({
  batchApplyTagService: { applyPerItem: mocks.applyPerItem },
}));
vi.mock("@/app/audit/audit-emit-service", () => ({
  dispatchAuditEvents: (...args: unknown[]) =>
    mocks.dispatchAuditEvents(...args),
  userAuditActor: (userId: string) => ({
    actorType: AuditActorType.User,
    actorId: userId,
  }),
}));
vi.mock("@/lib/artifact-activity-capture", () => ({
  captureBatchPriorityChange: (...args: unknown[]) =>
    mocks.captureBatchPriorityChange(...args),
  captureBatchTagApplied: (...args: unknown[]) =>
    mocks.captureBatchTagApplied(...args),
}));

import { POST as updatePriority } from "@/app/documents/batch-update-priority/v2/route";
import { POST as assignTags } from "@/app/entity-tags/batch/v2/route";

/**
 * The write's transaction client, as an opaque sentinel: the store is mocked,
 * so nothing calls a method on it and what the receipt assertions pin is that
 * the client the WRITE owns is what reaches the capture.
 */
const TX = Symbol("tx") as unknown as never;

const DOC_A = "11111111-1111-4111-8111-111111111111";
const DOC_B = "22222222-2222-4222-8222-222222222222";
const TAG_ID = "33333333-3333-4333-8333-333333333333";

/**
 * The action and object-type values are spelled as LITERALS, never imported
 * from the const they guard: a fixture built from the constant agrees with the
 * constant's own mistake, and these strings are hashed into an append-only
 * chain where a rename is not available as a correction.
 */
const DOCUMENT_PRIORITY_CHANGED = "document.priority_changed";
const ARTIFACT_TAG_APPLIED = "artifact.tag_applied";
const DOCUMENT_OBJECT_TYPE = "document";
const ARTIFACT_OBJECT_TYPE = "artifact";

type AuditEmission = {
  action: string;
  objectType: string;
  objectId: string;
  detail: { transactionId: string };
};

function emittedAuditEvents(callIndex = 0): AuditEmission[] {
  return mocks.dispatchAuditEvents.mock.calls[callIndex][0] as AuditEmission[];
}

async function runPriorityBatch(changedIds: string[]) {
  mocks.batchUpdatePriorityPerItem.mockResolvedValue({
    resultsById: new Map(
      changedIds.map((id) => [id, batchItemApplied(id)] as const)
    ) as Map<string, BatchItemResult>,
    changedIds,
    beforePriorities: new Map(changedIds.map((id) => [id, Priority.Low])),
  });
  const response = await updatePriority(
    createMockRequest({
      url: "http://localhost:3002/documents/batch-update-priority/v2",
      method: "POST",
      body: { documentIds: changedIds, priority: Priority.Urgent },
    }),
    createMockRouteContext({})
  );
  return (await response.json()).data as { transactionId?: string };
}

async function runTagBatch(entityIds: string[], newlyTaggedIds: string[]) {
  // The receipt is written by the callback the route hands the service
  // (ISS-10993), so the stand-in has to RUN it — a mock that took the argument
  // and dropped it would leave every receipt assertion below passing against a
  // route that had stopped writing receipts entirely.
  mocks.applyPerItem.mockImplementation(
    async (
      _tagId: string,
      _entityType: unknown,
      _ids: string[],
      _organizationId: string,
      recordReceipt?: (
        tx: unknown,
        ids: readonly string[],
        targetIds: readonly string[]
      ) => Promise<void>
    ) => {
      await recordReceipt?.(TX, newlyTaggedIds, entityIds);
      return {
        ok: true,
        value: {
          results: new Map(
            entityIds.map((id) => [id, batchItemApplied(id)] as const)
          ),
          newlyTaggedIds,
        },
      };
    }
  );
  const response = await assignTags(
    createMockRequest({
      url: "http://localhost:3002/entity-tags/batch/v2",
      method: "POST",
      body: { tagId: TAG_ID, entityType: TagEntityType.Artifact, entityIds },
    }),
    createMockRouteContext({})
  );
  return (await response.json()).data as { transactionId?: string };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockAuthContext = createTestAuthContext();
});

describe("bulk mutation transaction identity", () => {
  it("gives a priority batch's ledger entries, receipt and response ONE id", async () => {
    const data = await runPriorityBatch([DOC_A, DOC_B]);

    const emitted = emittedAuditEvents();
    expect(emitted).toHaveLength(2);
    const ids = new Set(emitted.map((event) => event.detail.transactionId));
    expect(ids.size).toBe(1);

    const transactionId = emitted[0].detail.transactionId;
    expect(transactionId).toEqual(expect.any(String));
    expect(data.transactionId).toBe(transactionId);
    expect(mocks.captureBatchPriorityChange).toHaveBeenCalledWith(
      expect.objectContaining({ transactionId })
    );
  });

  it("mints the vocabulary ruling 6 requires for a priority batch", async () => {
    await runPriorityBatch([DOC_A]);

    expect(emittedAuditEvents()[0]).toMatchObject({
      action: DOCUMENT_PRIORITY_CHANGED,
      objectType: DOCUMENT_OBJECT_TYPE,
      objectId: DOC_A,
    });
  });

  it("gives a tag batch's ledger entries, receipt and response ONE id", async () => {
    const data = await runTagBatch([DOC_A, DOC_B], [DOC_A, DOC_B]);

    const emitted = emittedAuditEvents();
    const transactionId = emitted[0].detail.transactionId;
    expect(new Set(emitted.map((e) => e.detail.transactionId)).size).toBe(1);
    expect(data.transactionId).toBe(transactionId);
    expect(mocks.captureBatchTagApplied).toHaveBeenCalledWith(
      expect.objectContaining({ transactionId, tagId: TAG_ID })
    );
  });

  it("mints the vocabulary ruling 6 requires for a tag batch", async () => {
    await runTagBatch([DOC_A], [DOC_A]);

    expect(emittedAuditEvents()[0]).toMatchObject({
      action: ARTIFACT_TAG_APPLIED,
      objectType: ARTIFACT_OBJECT_TYPE,
      objectId: DOC_A,
    });
  });

  it("gives two batches of DIFFERENT routes different ids", async () => {
    const priority = await runPriorityBatch([DOC_A]);
    const tags = await runTagBatch([DOC_A], [DOC_A]);

    expect(priority.transactionId).toEqual(expect.any(String));
    expect(tags.transactionId).not.toBe(priority.transactionId);
  });

  it("gives two batches of the SAME route different ids", async () => {
    const first = await runPriorityBatch([DOC_A]);
    const second = await runPriorityBatch([DOC_A]);

    expect(second.transactionId).not.toBe(first.transactionId);
  });

  it("writes no tag entry and no tag receipt for an item that already carried the tag", async () => {
    // The partial case ruling 1 exists for: `createMany({skipDuplicates})`
    // reports 2 applied, and only ONE artifact actually gained the tag.
    await runTagBatch([DOC_A, DOC_B], [DOC_B]);

    const emitted = emittedAuditEvents();
    expect(emitted.map((event) => event.objectId)).toEqual([DOC_B]);
    expect(mocks.captureBatchTagApplied).toHaveBeenCalledWith(
      expect.objectContaining({ taggedArtifactIds: [DOC_B] })
    );
  });

  it("writes nothing at all when a tag batch changed no row", async () => {
    await runTagBatch([DOC_A], []);

    expect(mocks.dispatchAuditEvents).not.toHaveBeenCalled();
    expect(mocks.captureBatchTagApplied).not.toHaveBeenCalled();
  });
});
