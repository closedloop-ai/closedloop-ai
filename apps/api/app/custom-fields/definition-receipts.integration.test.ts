import {
  OperationKind,
  OperationReceiptOutcome,
  OperationSource,
} from "@repo/api/src/types/attribution-evidence";
import { CustomFieldType } from "@repo/api/src/types/custom-field";
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
// The admin gate reads the caller's Clerk role; it is not under test here.
vi.mock("@/app/custom-fields/custom-fields-admin-gate", () => ({
  requireCustomFieldsAdmin: async () => null,
}));

import { PUT as updateOption } from "@/app/custom-fields/[id]/enum-options/[optionId]/route";
import { POST as reorderOptions } from "@/app/custom-fields/[id]/enum-options/reorder/route";
import { POST as createOption } from "@/app/custom-fields/[id]/enum-options/route";
import {
  DELETE as deleteField,
  PUT as updateField,
} from "@/app/custom-fields/[id]/route";
import { POST as createField } from "@/app/custom-fields/route";

const harness = createReceiptRouteHarness();
const organizationIds: string[] = [];

/**
 * ISS-12552: an API-key custom field definition or enum option
 * write records an organization-write receipt in the write's own transaction.
 */
describe.skipIf(!keys().DATABASE_URL)(
  "ISS-12552 custom field definition receipts",
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

    it("POST /custom-fields creates no field when its receipt cannot be stored", async () => {
      const world = await seedWorld();
      failReceiptInserts();

      const response = await createField(
        apiKeyRouteRequest("POST", "/custom-fields", {
          name: "Receipt field",
          fieldType: CustomFieldType.Text,
        }),
        receiptRouteParams({})
      );

      expect(response.status).toBe(500);
      expect(forcedReceiptFailures()).toBe(1);
      expect(await countFields(world.organizationId)).toBe(0);
      expect(await countReceipts(world.organizationId)).toBe(0);
    });

    it("PUT /custom-fields/[id] keeps the old name when its receipt cannot be stored", async () => {
      const world = await seedWorld();
      const field = await seedEnumField(world);
      failReceiptInserts();

      const response = await updateField(
        apiKeyRouteRequest("PUT", `/custom-fields/${field.id}`, {
          name: "Renamed",
        }),
        receiptRouteParams({ id: field.id })
      );

      expect(response.status).toBe(500);
      expect(forcedReceiptFailures()).toBe(1);
      expect(await fieldName(field.id)).toBe("Receipt enum");
      expect(await countReceipts(world.organizationId)).toBe(0);
    });

    it("DELETE /custom-fields/[id] keeps the field when its receipt cannot be stored", async () => {
      const world = await seedWorld();
      const field = await seedEnumField(world);
      failReceiptInserts();

      const response = await deleteField(
        apiKeyRouteRequest("DELETE", `/custom-fields/${field.id}`),
        receiptRouteParams({ id: field.id })
      );

      expect(response.status).toBe(500);
      expect(forcedReceiptFailures()).toBe(1);
      expect(await countFields(world.organizationId)).toBe(1);
      expect(await countReceipts(world.organizationId)).toBe(0);
    });

    it("POST enum-options creates no option when its receipt cannot be stored", async () => {
      const world = await seedWorld();
      const field = await seedEnumField(world);
      failReceiptInserts();

      const response = await createOption(
        apiKeyRouteRequest("POST", `/custom-fields/${field.id}/enum-options`, {
          name: "Gamma",
        }),
        receiptRouteParams({ id: field.id })
      );

      expect(response.status).toBe(500);
      expect(forcedReceiptFailures()).toBe(1);
      expect(await optionNames(field.id)).toEqual(["Alpha", "Beta"]);
      expect(await countReceipts(world.organizationId)).toBe(0);
    });

    it("PUT enum-options/[optionId] keeps the old name when its receipt cannot be stored", async () => {
      const world = await seedWorld();
      const field = await seedEnumField(world);
      const [alpha] = field.optionIds;
      failReceiptInserts();

      const response = await updateOption(
        apiKeyRouteRequest(
          "PUT",
          `/custom-fields/${field.id}/enum-options/${alpha}`,
          { name: "Renamed" }
        ),
        receiptRouteParams({ id: field.id, optionId: alpha })
      );

      expect(response.status).toBe(500);
      expect(forcedReceiptFailures()).toBe(1);
      expect(await optionNames(field.id)).toEqual(["Alpha", "Beta"]);
      expect(await countReceipts(world.organizationId)).toBe(0);
    });

    it("POST enum-options/reorder keeps the old order when its receipt cannot be stored", async () => {
      const world = await seedWorld();
      const field = await seedEnumField(world);
      failReceiptInserts();

      const response = await reorderOptions(
        apiKeyRouteRequest(
          "POST",
          `/custom-fields/${field.id}/enum-options/reorder`,
          { optionIds: [...field.optionIds].reverse() }
        ),
        receiptRouteParams({ id: field.id })
      );

      expect(response.status).toBe(500);
      expect(forcedReceiptFailures()).toBe(1);
      expect(await optionNames(field.id)).toEqual(["Alpha", "Beta"]);
      expect(await countReceipts(world.organizationId)).toBe(0);
    });

    it("records the columns an update moved, and a repeat as a no-op", async () => {
      const world = await seedWorld();
      const field = await seedEnumField(world);
      const update = () =>
        updateField(
          apiKeyRouteRequest("PUT", `/custom-fields/${field.id}`, {
            name: "Renamed",
            showInTable: false,
          }),
          receiptRouteParams({ id: field.id })
        );

      const statuses = [(await update()).status, (await update()).status];

      expect(statuses).toEqual([200, 200]);
      expect(await readReceipts(world.organizationId)).toEqual(
        [
          { outcome: OperationReceiptOutcome.Committed, changed: ["name"] },
          { outcome: OperationReceiptOutcome.NoOp, changed: [] },
        ].map(({ outcome, changed }) => ({
          operationKind: OperationKind.OrganizationWrite,
          outcome,
          source: OperationSource.Api,
          targetArtifactId: null,
          createdArtifactId: null,
          changedFields: changed,
          route: "/custom-fields/[id]",
        }))
      );
    });

    it("records a reorder that moved options, and the same order again as a no-op", async () => {
      const world = await seedWorld();
      const field = await seedEnumField(world);
      const reorder = () =>
        reorderOptions(
          apiKeyRouteRequest(
            "POST",
            `/custom-fields/${field.id}/enum-options/reorder`,
            { optionIds: [...field.optionIds].reverse() }
          ),
          receiptRouteParams({ id: field.id })
        );

      const statuses = [(await reorder()).status, (await reorder()).status];

      expect(statuses).toEqual([200, 200]);
      expect(await optionNames(field.id)).toEqual(["Beta", "Alpha"]);
      expect(
        (await readReceipts(world.organizationId)).map((receipt) => [
          receipt.operationKind,
          receipt.outcome,
          receipt.route,
        ])
      ).toEqual(
        [OperationReceiptOutcome.Committed, OperationReceiptOutcome.NoOp].map(
          (outcome) => [
            OperationKind.OrganizationWrite,
            outcome,
            "/custom-fields/[id]/enum-options/reorder",
          ]
        )
      );
    });

    it("writes no receipt with attribution-evidence-policy off", async () => {
      const world = await seedWorld();
      turnAttributionFlagOff();

      const response = await createField(
        apiKeyRouteRequest("POST", "/custom-fields", {
          name: "Receipt field",
          fieldType: CustomFieldType.Text,
        }),
        receiptRouteParams({})
      );

      expect(response.status).toBe(200);
      expect(await countFields(world.organizationId)).toBe(1);
      expect(await countReceipts(world.organizationId)).toBe(0);
    });
  }
);

async function seedWorld() {
  const world = await harness.seedWorld();
  organizationIds.push(world.organizationId);
  return world;
}

/** An ENUM field with options Alpha then Beta, written without a receipt. */
async function seedEnumField(world: {
  organizationId: string;
  userId: string;
}) {
  const field = await withDb((db) =>
    db.customField.create({
      data: {
        organizationId: world.organizationId,
        createdById: world.userId,
        name: "Receipt enum",
        fieldType: CustomFieldType.Enum,
        enumOptions: {
          create: [
            { name: "Alpha", sortOrder: 0 },
            { name: "Beta", sortOrder: 1 },
          ],
        },
      },
      select: {
        id: true,
        enumOptions: { orderBy: { sortOrder: "asc" }, select: { id: true } },
      },
    })
  );
  return {
    id: field.id,
    optionIds: field.enumOptions.map((option) => option.id),
  };
}

function countFields(organizationId: string): Promise<number> {
  return withDb((db) => db.customField.count({ where: { organizationId } }));
}

async function fieldName(fieldId: string): Promise<string | undefined> {
  const field = await withDb((db) =>
    db.customField.findUnique({
      where: { id: fieldId },
      select: { name: true },
    })
  );
  return field?.name;
}

async function optionNames(fieldId: string): Promise<string[]> {
  const options = await withDb((db) =>
    db.customFieldEnumOption.findMany({
      where: { customFieldId: fieldId },
      orderBy: { sortOrder: "asc" },
      select: { name: true },
    })
  );
  return options.map((option) => option.name);
}
