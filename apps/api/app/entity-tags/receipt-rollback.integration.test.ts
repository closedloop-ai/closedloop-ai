import { TagEntityType } from "@repo/api/src/types/tag";
import { withDb } from "@repo/database";
import { keys } from "@repo/database/keys";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  countReceipts,
  createReceiptRouteHarness,
  failReceiptInserts,
  forcedReceiptFailures,
  receiptRouteParams,
  receiptRouteRequest,
} from "@/__tests__/support/lib/operation-receipt-route.test-helpers";

// ISS-12552: receipts are recorded only while attribution-evidence-policy is on.
vi.mock(
  "@/lib/attribution-evidence-policy-feature",
  async (importOriginal) => ({
    ...(await importOriginal<
      typeof import("@/lib/attribution-evidence-policy-feature")
    >()),
    isAttributionEvidenceEnabledForOrganization: vi.fn(async () => true),
  })
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

import { POST as applyTag, DELETE as removeTag } from "@/app/entity-tags/route";

const harness = createReceiptRouteHarness();
const organizationIds: string[] = [];

/**
 * ISS-12552: a tag write and its operation receipt share one transaction, so
 * a receipt that cannot be stored leaves no write behind.
 */
describe.skipIf(!keys().DATABASE_URL)(
  "ISS-12552 tag writes roll back with their receipt",
  () => {
    afterEach(async () => {
      const orgIds = organizationIds.splice(0);
      await withDb((db) =>
        db.tag.deleteMany({ where: { organizationId: { in: orgIds } } })
      );
      await harness.cleanup();
    });

    it("POST /entity-tags leaves the artifact untagged", async () => {
      const { documentId, organizationId, tagId } = await seed();
      failReceiptInserts();

      const response = await applyTag(
        receiptRouteRequest("POST", "/entity-tags", {
          tagId,
          entityType: TagEntityType.Artifact,
          entityId: documentId,
        }),
        receiptRouteParams({})
      );

      expect(response.status).toBe(500);
      expect(forcedReceiptFailures()).toBe(1);
      expect(await countTags(documentId)).toBe(0);
      expect(await countReceipts(organizationId)).toBe(0);
    });

    it("DELETE /entity-tags keeps the tag", async () => {
      const { documentId, organizationId, tagId } = await seed();
      await withDb((db) =>
        db.tagArtifact.create({ data: { tagId, artifactId: documentId } })
      );
      failReceiptInserts();

      const query = new URLSearchParams({
        tagId,
        entityType: TagEntityType.Artifact,
        entityId: documentId,
      });
      const response = await removeTag(
        receiptRouteRequest("DELETE", `/entity-tags?${query.toString()}`),
        receiptRouteParams({})
      );

      expect(response.status).toBe(500);
      expect(forcedReceiptFailures()).toBe(1);
      expect(await countTags(documentId)).toBe(1);
      expect(await countReceipts(organizationId)).toBe(0);
    });
  }
);

async function seed() {
  const world = await harness.seedWorld();
  organizationIds.push(world.organizationId);
  const documentId = await harness.seedDocument(world, "Tagged");
  const tag = await withDb((db) =>
    db.tag.create({
      data: {
        organizationId: world.organizationId,
        name: "receipt-rollback",
        color: "blue",
        createdById: world.userId,
      },
      select: { id: true },
    })
  );
  return { ...world, documentId, tagId: tag.id };
}

function countTags(documentId: string): Promise<number> {
  return withDb((db) =>
    db.tagArtifact.count({ where: { artifactId: documentId } })
  );
}
