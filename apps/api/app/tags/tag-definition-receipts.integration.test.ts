import {
  OperationKind,
  OperationReceiptOutcome,
  OperationSource,
} from "@repo/api/src/types/attribution-evidence";
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

import { DELETE as deleteTag, PATCH as updateTag } from "@/app/tags/[id]/route";
import { POST as createTag } from "@/app/tags/route";

const harness = createReceiptRouteHarness();

/**
 * ISS-12552: an API-key tag definition write records an
 * organization-write receipt in the write's own transaction.
 */
describe.skipIf(!keys().DATABASE_URL)(
  "ISS-12552 tag definition receipts",
  () => {
    afterEach(() => harness.cleanup());

    it("POST /tags creates no tag when its receipt cannot be stored", async () => {
      const world = await harness.seedWorld();
      failReceiptInserts();

      const response = await createTag(
        apiKeyRouteRequest("POST", "/tags", { name: "receipt-create" }),
        receiptRouteParams({})
      );

      expect(response.status).toBe(500);
      expect(forcedReceiptFailures()).toBe(1);
      expect(await countTags(world.organizationId)).toBe(0);
      expect(await countReceipts(world.organizationId)).toBe(0);
    });

    it("PATCH /tags/[id] keeps the old name when its receipt cannot be stored", async () => {
      const world = await harness.seedWorld();
      const tagId = await seedTag(world, "receipt-before");
      failReceiptInserts();

      const response = await updateTag(
        apiKeyRouteRequest("PATCH", `/tags/${tagId}`, {
          name: "receipt-after",
        }),
        receiptRouteParams({ id: tagId })
      );

      expect(response.status).toBe(500);
      expect(forcedReceiptFailures()).toBe(1);
      expect(await tagName(tagId)).toBe("receipt-before");
      expect(await countReceipts(world.organizationId)).toBe(0);
    });

    it("DELETE /tags/[id] keeps the tag when its receipt cannot be stored", async () => {
      const world = await harness.seedWorld();
      const tagId = await seedTag(world, "receipt-delete");
      failReceiptInserts();

      const response = await deleteTag(
        apiKeyRouteRequest("DELETE", `/tags/${tagId}`),
        receiptRouteParams({ id: tagId })
      );

      expect(response.status).toBe(500);
      expect(forcedReceiptFailures()).toBe(1);
      expect(await countTags(world.organizationId)).toBe(1);
      expect(await countReceipts(world.organizationId)).toBe(0);
    });

    it("records the fields a rename moved, and a repeat as a no-op", async () => {
      const world = await harness.seedWorld();
      const tagId = await seedTag(world, "receipt-before");
      const rename = () =>
        updateTag(
          apiKeyRouteRequest("PATCH", `/tags/${tagId}`, {
            name: "receipt-after",
          }),
          receiptRouteParams({ id: tagId })
        );

      const statuses = [(await rename()).status, (await rename()).status];

      expect(statuses).toEqual([200, 200]);
      expect(await readReceipts(world.organizationId)).toEqual([
        {
          operationKind: OperationKind.OrganizationWrite,
          outcome: OperationReceiptOutcome.Committed,
          source: OperationSource.Api,
          targetArtifactId: null,
          createdArtifactId: null,
          changedFields: ["name"],
          route: "/tags/[id]",
        },
        {
          operationKind: OperationKind.OrganizationWrite,
          outcome: OperationReceiptOutcome.NoOp,
          source: OperationSource.Api,
          targetArtifactId: null,
          createdArtifactId: null,
          changedFields: [],
          route: "/tags/[id]",
        },
      ]);
    });

    it("records a committed organization write for a created tag", async () => {
      const world = await harness.seedWorld();

      const response = await createTag(
        apiKeyRouteRequest("POST", "/tags", { name: "receipt-create" }),
        receiptRouteParams({})
      );

      expect(response.status).toBe(200);
      expect(await readReceipts(world.organizationId)).toEqual([
        {
          operationKind: OperationKind.OrganizationWrite,
          outcome: OperationReceiptOutcome.Committed,
          source: OperationSource.Api,
          targetArtifactId: null,
          createdArtifactId: null,
          changedFields: [],
          route: "/tags",
        },
      ]);
    });

    it("writes no receipt with attribution-evidence-policy off", async () => {
      const world = await harness.seedWorld();
      turnAttributionFlagOff();

      const response = await createTag(
        apiKeyRouteRequest("POST", "/tags", { name: "receipt-flag-off" }),
        receiptRouteParams({})
      );

      expect(response.status).toBe(200);
      expect(await countTags(world.organizationId)).toBe(1);
      expect(await countReceipts(world.organizationId)).toBe(0);
    });
  }
);

function countTags(organizationId: string): Promise<number> {
  return withDb((db) => db.tag.count({ where: { organizationId } }));
}

async function tagName(tagId: string): Promise<string | undefined> {
  const tag = await withDb((db) =>
    db.tag.findUnique({ where: { id: tagId }, select: { name: true } })
  );
  return tag?.name;
}

async function seedTag(
  world: { organizationId: string; userId: string },
  name: string
): Promise<string> {
  const tag = await withDb((db) =>
    db.tag.create({
      data: {
        organizationId: world.organizationId,
        createdById: world.userId,
        name,
        color: "blue",
      },
      select: { id: true },
    })
  );
  return tag.id;
}
