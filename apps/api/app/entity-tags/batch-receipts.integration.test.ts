import {
  OperationKind,
  OperationReceiptOutcome,
  OperationSource,
} from "@repo/api/src/types/attribution-evidence";
import { TagEntityType } from "@repo/api/src/types/tag";
import { withDb } from "@repo/database";
import { keys } from "@repo/database/keys";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  apiKeyRouteRequest,
  countReceipts,
  createReceiptRouteHarness,
  failReceiptInserts,
  forcedReceiptFailures,
  readReceipts,
  receiptRouteParams,
  turnAttributionFlagOff,
} from "@/__tests__/support/lib/operation-receipt-route.test-helpers";

vi.mock("@/lib/attribution-evidence-policy-feature", async (importOriginal) =>
  (
    await import("@/__tests__/support/lib/operation-receipt-route.test-mocks")
  ).receiptRouteFlagMock(await importOriginal())
);
vi.mock("@/lib/auth/with-any-auth", async () =>
  (
    await import("@/__tests__/support/lib/operation-receipt-route.test-mocks")
  ).receiptRouteAuthMock()
);
vi.mock("@vercel/functions", async () =>
  (
    await import("@/__tests__/support/lib/operation-receipt-route.test-mocks")
  ).receiptRouteWaitUntilMock()
);
vi.mock(
  "@/lib/operation-receipts/operation-receipt-writer",
  async (importOriginal) =>
    (
      await import("@/__tests__/support/lib/operation-receipt-route.test-mocks")
    ).failingReceiptWriterMock(await importOriginal())
);

import { POST as applyBatch } from "@/app/entity-tags/batch/route";
import { POST as applyBatchV2 } from "@/app/entity-tags/batch/v2/route";
import { POST as removeBatchV2 } from "@/app/entity-tags/batch-remove/v2/route";

const harness = createReceiptRouteHarness();

/**
 * ISS-12552: an API-key batch tag write records one receipt per
 * artifact, inside the batch's own transaction.
 */
describe.skipIf(!keys().DATABASE_URL)(
  "ISS-12552 entity-tag batch receipts",
  () => {
    afterEach(() => harness.cleanup());

    it("POST /entity-tags/batch tags nothing when a receipt cannot be stored", async () => {
      const { organizationId, tagId, tagged, untagged } = await seed();
      failReceiptInserts();

      const response = await applyBatch(
        batchRequest("/entity-tags/batch", tagId, [tagged, untagged]),
        receiptRouteParams({})
      );

      expect(response.status).toBe(500);
      expect(forcedReceiptFailures()).toBe(1);
      expect(await taggedIds(tagId)).toEqual([tagged]);
      expect(await countReceipts(organizationId)).toBe(0);
    });

    it("POST /entity-tags/batch/v2 tags nothing when a receipt cannot be stored", async () => {
      const { organizationId, tagId, tagged, untagged } = await seed();
      failReceiptInserts();

      const response = await applyBatchV2(
        batchRequest("/entity-tags/batch/v2", tagId, [tagged, untagged]),
        receiptRouteParams({})
      );

      expect(response.status).toBe(500);
      expect(forcedReceiptFailures()).toBe(1);
      expect(await taggedIds(tagId)).toEqual([tagged]);
      expect(await countReceipts(organizationId)).toBe(0);
    });

    it("POST /entity-tags/batch-remove/v2 keeps the tag when a receipt cannot be stored", async () => {
      const { organizationId, tagId, tagged, untagged } = await seed();
      failReceiptInserts();

      const response = await removeBatchV2(
        batchRequest("/entity-tags/batch-remove/v2", tagId, [tagged, untagged]),
        receiptRouteParams({})
      );

      expect(response.status).toBe(500);
      expect(forcedReceiptFailures()).toBe(1);
      expect(await taggedIds(tagId)).toEqual([tagged]);
      expect(await countReceipts(organizationId)).toBe(0);
    });

    it("records a tag receipt per artifact, a no-op for one already tagged", async () => {
      const { organizationId, tagId, tagged, untagged } = await seed();

      const response = await applyBatchV2(
        batchRequest("/entity-tags/batch/v2", tagId, [tagged, untagged]),
        receiptRouteParams({})
      );

      expect(response.status).toBe(200);
      expect(await receiptsByTarget(organizationId)).toEqual(
        [
          { target: tagged, outcome: OperationReceiptOutcome.NoOp },
          { target: untagged, outcome: OperationReceiptOutcome.Committed },
        ]
          .sort((a, b) => a.target.localeCompare(b.target))
          .map(({ target, outcome }) => ({
            operationKind: OperationKind.Tag,
            outcome,
            source: OperationSource.Api,
            targetArtifactId: target,
            createdArtifactId: null,
            changedFields: [],
            route: "/entity-tags/batch/v2",
          }))
      );
    });

    it("records an untag receipt per artifact, a no-op for one never tagged", async () => {
      const { organizationId, tagId, tagged, untagged } = await seed();

      const response = await removeBatchV2(
        batchRequest("/entity-tags/batch-remove/v2", tagId, [tagged, untagged]),
        receiptRouteParams({})
      );

      expect(response.status).toBe(200);
      expect(
        (await receiptsByTarget(organizationId)).map((receipt) => [
          receipt.operationKind,
          receipt.targetArtifactId,
          receipt.outcome,
          receipt.route,
        ])
      ).toEqual(
        [
          [tagged, OperationReceiptOutcome.Committed],
          [untagged, OperationReceiptOutcome.NoOp],
        ]
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([target, outcome]) => [
            OperationKind.Untag,
            target,
            outcome,
            "/entity-tags/batch-remove/v2",
          ])
      );
    });

    it("writes no receipt with attribution-evidence-policy off", async () => {
      const { organizationId, tagId, tagged, untagged } = await seed();
      turnAttributionFlagOff();

      const response = await applyBatch(
        batchRequest("/entity-tags/batch", tagId, [tagged, untagged]),
        receiptRouteParams({})
      );

      expect(response.status).toBe(200);
      expect(await taggedIds(tagId)).toEqual([tagged, untagged].sort());
      expect(await countReceipts(organizationId)).toBe(0);
    });
  }
);

/** A world with a tag, one document carrying it and one without. */
async function seed() {
  const world = await harness.seedWorld();
  const tagged = await harness.seedDocument(world, "Tagged");
  const untagged = await harness.seedDocument(world, "Untagged");
  const tag = await withDb((db) =>
    db.tag.create({
      data: {
        organizationId: world.organizationId,
        name: "batch-receipts",
        color: "blue",
        createdById: world.userId,
      },
      select: { id: true },
    })
  );
  await withDb((db) =>
    db.tagArtifact.create({ data: { tagId: tag.id, artifactId: tagged } })
  );
  return { ...world, tagId: tag.id, tagged, untagged };
}

function batchRequest(path: string, tagId: string, entityIds: string[]) {
  return apiKeyRouteRequest("POST", path, {
    tagId,
    entityType: TagEntityType.Artifact,
    entityIds,
  });
}

async function taggedIds(tagId: string): Promise<string[]> {
  const rows = await withDb((db) =>
    db.tagArtifact.findMany({ where: { tagId }, select: { artifactId: true } })
  );
  return rows.map((row) => row.artifactId).sort();
}

/** Receipts written in one transaction share a timestamp, so order by target. */
async function receiptsByTarget(organizationId: string) {
  const receipts = await readReceipts(organizationId);
  return receipts.sort((a, b) =>
    (a.targetArtifactId ?? "").localeCompare(b.targetArtifactId ?? "")
  );
}
