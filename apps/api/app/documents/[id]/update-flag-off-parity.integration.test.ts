import { ArtifactFieldEditField } from "@repo/api/src/types/artifact-field-edit-receipt";
import { CustomFieldType } from "@repo/api/src/types/custom-field";
import { DocumentStatus } from "@repo/api/src/types/document";
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
  turnAttributionFlagOff,
} from "@/__tests__/support/lib/operation-receipt-route.test-helpers";
import { receiptRouteState } from "@/__tests__/support/lib/operation-receipt-route.test-mocks";
import { createTestAuthContext } from "@/__tests__/utils/auth-helpers";
import type { AuthContext } from "@/lib/auth/with-auth";

const events = vi.hoisted(() => ({ order: [] as string[] }));

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
vi.mock("@/lib/artifact-field-edit-analytics", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("@/lib/artifact-field-edit-analytics")
    >();
  return {
    ...actual,
    captureArtifactFieldEditAnalytics: (
      ...args: Parameters<typeof actual.captureArtifactFieldEditAnalytics>
    ) => {
      if (args[0].field === ArtifactFieldEditField.CustomField) {
        events.order.push("field-analytics");
      }
      return actual.captureArtifactFieldEditAnalytics(...args);
    },
  };
});

import { artifactCustomFieldValueService } from "@/app/custom-fields/artifact-custom-field-value-service";
import { PUT as updateDocument } from "@/app/documents/[id]/route";
import { blockedDependentUnblockService } from "@/app/documents/blocked-dependent-unblock-service";

const harness = createReceiptRouteHarness();
const customFields = createDocumentCustomFieldTracker();

/**
 * ISS-12552: flag-off behavior equals main for PUT /documents/[id]. With
 * `attribution-evidence-policy` off, it commits the document and fires its
 * effects before any custom field write, outside the document's transaction.
 */
describe.skipIf(!keys().DATABASE_URL)(
  "ISS-12552 document update matches main with attribution evidence off",
  () => {
    beforeEach(() => {
      events.order = [];
    });
    afterEach(async () => {
      vi.restoreAllMocks();
      await customFields.cleanup();
      await harness.cleanup();
    });

    it("a field write that throws leaves the document committed, its effects fired, and answers 500", async () => {
      const { documentId, fieldId } = await seedOff();
      const resolveBlocks = spyOnDocumentEffects();
      vi.spyOn(artifactCustomFieldValueService, "set").mockRejectedValue(
        new Error("forced field failure")
      );

      const response = await putUpdate(documentId, { [fieldId]: "value" });

      expect(response.status).toBe(500);
      expect(await readStoredDocument(documentId)).toEqual({
        title: "Renamed",
        status: DocumentStatus.InReview,
        values: 0,
      });
      expect(resolveBlocks).toHaveBeenCalledTimes(1);
    });

    it("commits the document and fires its effects before the first field write, whose analytics fire at once", async () => {
      const { organizationId, documentId, fieldId } = await seedOff();
      spyOnDocumentEffects();
      const statusAtFieldWrite: string[] = [];
      const set = artifactCustomFieldValueService.set.bind(
        artifactCustomFieldValueService
      );
      vi.spyOn(artifactCustomFieldValueService, "set").mockImplementation(
        async (...args) => {
          events.order.push("field-write-start");
          statusAtFieldWrite.push(
            (await readStoredDocument(documentId)).status
          );
          const result = await set(...args);
          events.order.push("field-write-end");
          return result;
        }
      );

      const response = await putUpdate(documentId, { [fieldId]: "value" });

      expect(response.status).toBe(200);
      expect(events.order).toEqual([
        "document-effects",
        "field-write-start",
        "field-analytics",
        "field-write-end",
      ]);
      expect(statusAtFieldWrite).toEqual([DocumentStatus.InReview]);
      expect((await readStoredDocument(documentId)).values).toBe(1);
      expect(await countReceipts(organizationId)).toBe(0);
    });

    it("never evaluates the flag for a session caller", async () => {
      const world = await harness.seedWorld();
      const documentId = await harness.seedDocument(world, "Original");
      const apiKeyContext = receiptRouteState.context as AuthContext;
      receiptRouteState.context = createTestAuthContext({
        user: apiKeyContext.user,
        authMethod: "session",
      });

      const response = await updateDocument(
        apiKeyRouteRequest("PUT", `/documents/${documentId}`, {
          title: "Renamed",
        }),
        receiptRouteParams({ id: documentId })
      );

      expect(response.status).toBe(200);
      expect(receiptRouteState.attributionFlagEvaluations).toBe(0);
    });

    it("evaluates the flag once for an API-key caller", async () => {
      const world = await harness.seedWorld();
      const documentId = await harness.seedDocument(world, "Original");

      const response = await updateDocument(
        apiKeyRouteRequest("PUT", `/documents/${documentId}`, {
          title: "Renamed",
        }),
        receiptRouteParams({ id: documentId })
      );

      expect(response.status).toBe(200);
      expect(receiptRouteState.attributionFlagEvaluations).toBe(1);
    });
  }
);

async function seedOff() {
  const world = await harness.seedWorld();
  const documentId = await harness.seedDocument(world, "Original");
  const fieldId = await customFields.seed(
    world.organizationId,
    CustomFieldType.Text
  );
  turnAttributionFlagOff();
  return { organizationId: world.organizationId, documentId, fieldId };
}

/** The status change's post-commit sweep stands in for the route's effects. */
function spyOnDocumentEffects() {
  const resolve =
    blockedDependentUnblockService.resolveBlocksForChangedArtifacts.bind(
      blockedDependentUnblockService
    );
  return vi
    .spyOn(blockedDependentUnblockService, "resolveBlocksForChangedArtifacts")
    .mockImplementation(async (...args) => {
      events.order.push("document-effects");
      return await resolve(...args);
    });
}

function putUpdate(
  documentId: string,
  fields: Record<string, string>
): Promise<Response> {
  return updateDocument(
    apiKeyRouteRequest("PUT", `/documents/${documentId}`, {
      title: "Renamed",
      status: DocumentStatus.InReview,
      customFields: fields,
    }),
    receiptRouteParams({ id: documentId })
  );
}
