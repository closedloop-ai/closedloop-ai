import { LinkType } from "@repo/api/src/types/artifact";
import {
  DocumentType,
  SourceLinkedPlanPolicy,
} from "@repo/api/src/types/document";
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

import { POST as createDocument } from "@/app/documents/route";

const harness = createReceiptRouteHarness();

/**
 * ISS-12552: reusing a source-linked plan records its no-op receipt on the
 * same locked transaction that decided the reuse, so a receipt that cannot be
 * stored fails the request instead of answering with no receipt.
 */
describe.skipIf(!keys().DATABASE_URL)(
  "ISS-12552 source-linked plan reuse receipt",
  () => {
    afterEach(() => harness.cleanup());

    it("POST /documents fails a reuse whose receipt cannot be stored", async () => {
      const world = await harness.seedWorld();
      const sourceId = await harness.seedDocument(world, "Source PRD");
      const body = {
        type: DocumentType.ImplementationPlan,
        title: "Implementation plan",
        content: "Plan content",
        projectId: world.projectId,
        sourceId,
        sourceLinkedPlanPolicy: SourceLinkedPlanPolicy.ReuseOrCreate,
      };
      const created = await createDocument(
        receiptRouteRequest("POST", "/documents", body),
        receiptRouteParams({})
      );
      expect(created.status).toBe(200);
      failReceiptInserts();

      const reused = await createDocument(
        receiptRouteRequest("POST", "/documents", body),
        receiptRouteParams({})
      );

      expect(reused.status).toBe(500);
      expect(forcedReceiptFailures()).toBe(1);
      expect(
        await withDb((db) =>
          db.artifactLink.count({
            where: { sourceId, linkType: LinkType.Produces },
          })
        )
      ).toBe(1);
      expect(await countReceipts(world.organizationId)).toBe(1);
    });
  }
);
