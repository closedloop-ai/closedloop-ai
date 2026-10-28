import { randomUUID } from "node:crypto";
import { CustomFieldType } from "@repo/api/src/types/custom-field";
import { keys } from "@repo/database/keys";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createDocumentCustomFieldTracker,
  readStoredDocument,
} from "@/__tests__/support/documents/document-parity.test-fixtures";
import {
  apiKeyRouteRequest,
  countReceipts,
  createReceiptRouteHarness,
  receiptRouteParams,
} from "@/__tests__/support/lib/operation-receipt-route.test-helpers";

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
/** PostHog answers nothing for the organization's group. */
vi.mock(
  "@/lib/feature-flags/server-feature-flag-evaluation",
  async (importOriginal) => ({
    ...(await importOriginal<
      typeof import("@/lib/feature-flags/server-feature-flag-evaluation")
    >()),
    evaluateServerFeatureFlagForOrganization: vi.fn(async () => null),
    resolveUnmemoizedFeatureFlagValue: vi.fn(async () => undefined),
  })
);

import { customFieldValuesService } from "@/app/custom-fields/values-service";
import { PUT as updateDocument } from "@/app/documents/[id]/route";
import { clearAttributionEvidenceGateMemo } from "@/lib/attribution-evidence-policy-feature";
import { evaluateServerFeatureFlagForOrganization } from "@/lib/feature-flags/server-feature-flag-evaluation";

const harness = createReceiptRouteHarness();
const customFields = createDocumentCustomFieldTracker();

/**
 * ISS-12552: an unavailable PostHog answer reads as off through the real
 * evaluation path, so an API-key PUT /documents/[id] takes main's shape (a
 * refused custom field half-applies) and records no receipt.
 */
describe.skipIf(!keys().DATABASE_URL)(
  "ISS-12552 document update with the attribution flag unavailable",
  () => {
    beforeEach(() => {
      clearAttributionEvidenceGateMemo();
    });
    afterEach(async () => {
      vi.restoreAllMocks();
      await customFields.cleanup();
      await harness.cleanup();
    });

    it("half-applies a refused custom field like main and records nothing", async () => {
      const world = await harness.seedWorld();
      const documentId = await harness.seedDocument(world, "Original");
      const textFieldId = await customFields.seed(
        world.organizationId,
        CustomFieldType.Text
      );
      const enumFieldId = await customFields.seed(
        world.organizationId,
        CustomFieldType.Enum
      );
      vi.spyOn(
        customFieldValuesService,
        "validateValueForEntity"
      ).mockResolvedValue(undefined);

      const response = await updateDocument(
        apiKeyRouteRequest("PUT", `/documents/${documentId}`, {
          title: "Renamed",
          customFields: {
            [textFieldId]: "applied first",
            [enumFieldId]: randomUUID(),
          },
        }),
        receiptRouteParams({ id: documentId })
      );

      expect(response.status).toBe(400);
      expect(evaluateServerFeatureFlagForOrganization).toHaveBeenCalled();
      const { title, values } = await readStoredDocument(documentId);
      expect({ title, values }).toEqual({ title: "Renamed", values: 1 });
      expect(await countReceipts(world.organizationId)).toBe(0);
    });
  }
);
