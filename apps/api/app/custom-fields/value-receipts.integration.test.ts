import {
  OperationKind,
  OperationReceiptOutcome,
  OperationSource,
} from "@repo/api/src/types/attribution-evidence";
import {
  CustomFieldEntityType,
  CustomFieldType,
} from "@repo/api/src/types/custom-field";
import { ArtifactType, withDb } from "@repo/database";
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
import { createTestSessionDetail } from "@/__tests__/utils/db-helpers";
import { customFieldChanges } from "@/lib/operation-receipts/changed-fields";

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

import {
  DELETE as deleteSessionValue,
  PUT as putSessionValue,
} from "@/app/agent-sessions/[id]/custom-field-values/[fieldId]/route";
import {
  DELETE as deleteBranchValue,
  PUT as putBranchValue,
} from "@/app/branches/[id]/custom-field-values/[fieldId]/route";

const harness = createReceiptRouteHarness();
const organizationIds: string[] = [];
const SESSION_VALUE_ROUTE =
  "/agent-sessions/[id]/custom-field-values/[fieldId]";

/**
 * ISS-12552: an API-key custom field value write on a session or
 * branch records a field-update receipt on that artifact, in the value
 * write's own transaction.
 */
describe.skipIf(!keys().DATABASE_URL)(
  "ISS-12552 custom field value receipts",
  () => {
    afterEach(async () => {
      const orgIds = organizationIds.splice(0);
      // Custom fields do not cascade from their organization.
      await withDb((db) =>
        db.customField.deleteMany({
          where: { organizationId: { in: orgIds } },
        })
      );
      await harness.cleanup();
    });

    it("PUT on a session stores no value when its receipt cannot be stored", async () => {
      const { organizationId, sessionId, fieldId } = await seed();
      failReceiptInserts();

      const response = await putSessionValue(
        valueRequest("PUT", "agent-sessions", sessionId, fieldId, {
          value: "set",
        }),
        receiptRouteParams({ id: sessionId, fieldId })
      );

      expect(response.status).toBe(500);
      expect(forcedReceiptFailures()).toBe(1);
      expect(await storedValue(fieldId, sessionId)).toBeNull();
      expect(await countReceipts(organizationId)).toBe(0);
    });

    it("PUT null on a branch keeps the value when its receipt cannot be stored", async () => {
      const { organizationId, branchId, fieldId } = await seed();
      await seedValue(
        organizationId,
        fieldId,
        CustomFieldEntityType.Branch,
        branchId
      );
      failReceiptInserts();

      const response = await putBranchValue(
        valueRequest("PUT", "branches", branchId, fieldId, { value: null }),
        receiptRouteParams({ id: branchId, fieldId })
      );

      expect(response.status).toBe(500);
      expect(forcedReceiptFailures()).toBe(1);
      expect(await storedValue(fieldId, branchId)).toBe("seeded");
      expect(await countReceipts(organizationId)).toBe(0);
    });

    it("DELETE on a branch keeps the value when its receipt cannot be stored", async () => {
      const { organizationId, branchId, fieldId } = await seed();
      await seedValue(
        organizationId,
        fieldId,
        CustomFieldEntityType.Branch,
        branchId
      );
      failReceiptInserts();

      const response = await deleteBranchValue(
        valueRequest("DELETE", "branches", branchId, fieldId),
        receiptRouteParams({ id: branchId, fieldId })
      );

      expect(response.status).toBe(500);
      expect(forcedReceiptFailures()).toBe(1);
      expect(await storedValue(fieldId, branchId)).toBe("seeded");
      expect(await countReceipts(organizationId)).toBe(0);
    });

    it("DELETE on a session keeps the value when its receipt cannot be stored", async () => {
      const { organizationId, sessionId, fieldId } = await seed();
      await seedValue(
        organizationId,
        fieldId,
        CustomFieldEntityType.Session,
        sessionId
      );
      failReceiptInserts();

      const response = await deleteSessionValue(
        valueRequest("DELETE", "agent-sessions", sessionId, fieldId),
        receiptRouteParams({ id: sessionId, fieldId })
      );

      expect(response.status).toBe(500);
      expect(forcedReceiptFailures()).toBe(1);
      expect(await storedValue(fieldId, sessionId)).toBe("seeded");
      expect(await countReceipts(organizationId)).toBe(0);
    });

    it("records the custom field it moved on the session, and a repeat as a no-op", async () => {
      const { organizationId, sessionId, fieldId } = await seed();
      const put = () =>
        putSessionValue(
          valueRequest("PUT", "agent-sessions", sessionId, fieldId, {
            value: "set",
          }),
          receiptRouteParams({ id: sessionId, fieldId })
        );

      const statuses = [(await put()).status, (await put()).status];

      expect(statuses).toEqual([200, 200]);
      expect(await readReceipts(organizationId)).toEqual(
        [
          {
            outcome: OperationReceiptOutcome.Committed,
            changed: customFieldChanges([fieldId]),
          },
          { outcome: OperationReceiptOutcome.NoOp, changed: [] },
        ].map(({ outcome, changed }) => ({
          operationKind: OperationKind.UpdateFields,
          outcome,
          source: OperationSource.Api,
          targetArtifactId: sessionId,
          createdArtifactId: null,
          changedFields: changed,
          route: SESSION_VALUE_ROUTE,
        }))
      );
    });

    it("writes no receipt with attribution-evidence-policy off", async () => {
      const { organizationId, branchId, fieldId } = await seed();
      turnAttributionFlagOff();

      const response = await putBranchValue(
        valueRequest("PUT", "branches", branchId, fieldId, { value: "set" }),
        receiptRouteParams({ id: branchId, fieldId })
      );

      expect(response.status).toBe(200);
      expect(await storedValue(fieldId, branchId)).toBe("set");
      expect(await countReceipts(organizationId)).toBe(0);
    });
  }
);

/** A session, a branch, and a TEXT field that applies to both. */
async function seed() {
  const world = await harness.seedWorld();
  organizationIds.push(world.organizationId);
  const sessionId = await createTestSessionDetail({
    organizationId: world.organizationId,
    userId: world.userId,
    label: "value-receipts",
  });
  const branch = await withDb((db) =>
    db.artifact.create({
      data: {
        organizationId: world.organizationId,
        type: ArtifactType.BRANCH,
        name: "value-receipts-branch",
        status: "open",
        createdById: world.userId,
      },
      select: { id: true },
    })
  );
  const field = await withDb((db) =>
    db.customField.create({
      data: {
        organizationId: world.organizationId,
        createdById: world.userId,
        name: "Receipt value",
        fieldType: CustomFieldType.Text,
        entityTypes: [
          CustomFieldEntityType.Session,
          CustomFieldEntityType.Branch,
        ],
      },
      select: { id: true },
    })
  );
  return { ...world, sessionId, branchId: branch.id, fieldId: field.id };
}

function valueRequest(
  method: string,
  collection: string,
  entityId: string,
  fieldId: string,
  body?: unknown
) {
  return apiKeyRouteRequest(
    method,
    `/${collection}/${entityId}/custom-field-values/${fieldId}`,
    body
  );
}

async function seedValue(
  organizationId: string,
  fieldId: string,
  entityType: CustomFieldEntityType,
  entityId: string
) {
  await withDb((db) =>
    db.customFieldValue.create({
      data: {
        customFieldId: fieldId,
        organizationId,
        entityType,
        entityId,
        textValue: "seeded",
        displayValue: "seeded",
        multiEnumValueIds: [],
        peopleValueIds: [],
      },
      select: { id: true },
    })
  );
}

async function storedValue(
  fieldId: string,
  entityId: string
): Promise<string | null> {
  const row = await withDb((db) =>
    db.customFieldValue.findFirst({
      where: { customFieldId: fieldId, entityId },
      select: { textValue: true },
    })
  );
  return row?.textValue ?? null;
}
