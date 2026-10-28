import { randomUUID } from "node:crypto";
import {
  OperationKind,
  OperationReceiptOutcome,
} from "@repo/api/src/types/attribution-evidence";
import {
  CustomFieldEntityType,
  CustomFieldType,
} from "@repo/api/src/types/custom-field";
import { withDb } from "@repo/database";
import { keys } from "@repo/database/keys";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createReceiptRouteHarness,
  receiptRouteParams,
  receiptRouteRequest,
} from "@/__tests__/support/lib/operation-receipt-route.test-helpers";
import { customFieldValuesService } from "@/app/custom-fields/values-service";
import { CUSTOM_FIELD_CHANGE_PREFIX } from "@/lib/operation-receipts/changed-fields";

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

import { PUT as updateProject } from "@/app/projects/[id]/route";

const harness = createReceiptRouteHarness();
const PROJECT_ROUTE = "/projects/[id]";
const customFieldIds = new Set<string>();

/**
 * ISS-12552: a project update and the custom fields it sets commit in
 * one transaction, with one receipt naming every column and value that moved.
 */
describe.skipIf(!keys().DATABASE_URL)(
  "ISS-12552 project update receipt with custom fields",
  () => {
    afterEach(async () => {
      vi.restoreAllMocks();
      await withDb(async (db) => {
        await db.customFieldValue.deleteMany({
          where: { customFieldId: { in: [...customFieldIds] } },
        });
        await db.customField.deleteMany({
          where: { id: { in: [...customFieldIds] } },
        });
      });
      customFieldIds.clear();
      await harness.cleanup();
    });

    it("records an unchanged custom field as a no-op and a changed one as committed naming it", async () => {
      const world = await harness.seedWorld();
      const fieldId = await seedTextField(world.organizationId);
      const put = (value: string, callId: string) =>
        updateProject(
          receiptRouteRequest(
            "PUT",
            `/projects/${world.projectId}`,
            { customFields: { [fieldId]: value } },
            callId
          ),
          receiptRouteParams({ id: world.projectId })
        );

      const first = await put("first", "toolu_first");
      const unchanged = await put("first", "toolu_unchanged");
      const changed = await put("second", "toolu_changed");

      expect([first.status, unchanged.status, changed.status]).toEqual([
        200, 200, 200,
      ]);
      expect(await readReceipts(world.organizationId)).toEqual([
        {
          operationKind: OperationKind.ProjectWrite,
          outcome: OperationReceiptOutcome.Committed,
          changedFields: [`${CUSTOM_FIELD_CHANGE_PREFIX}${fieldId}`],
          clientCallId: "toolu_first",
          route: PROJECT_ROUTE,
        },
        {
          operationKind: OperationKind.ProjectWrite,
          outcome: OperationReceiptOutcome.NoOp,
          changedFields: [],
          clientCallId: "toolu_unchanged",
          route: PROJECT_ROUTE,
        },
        {
          operationKind: OperationKind.ProjectWrite,
          outcome: OperationReceiptOutcome.Committed,
          changedFields: [`${CUSTOM_FIELD_CHANGE_PREFIX}${fieldId}`],
          clientCallId: "toolu_changed",
          route: PROJECT_ROUTE,
        },
      ]);
    });

    it("rolls the whole update back when a custom field is refused mid-apply", async () => {
      const world = await harness.seedWorld();
      const textFieldId = await seedTextField(world.organizationId);
      const enumFieldId = await seedField(
        world.organizationId,
        CustomFieldType.Enum
      );
      // A value can turn invalid between the preflight and the write (a
      // reference target deleted meanwhile); skipping the preflight puts the
      // refusal on the write path.
      vi.spyOn(
        customFieldValuesService,
        "validateValueForEntity"
      ).mockResolvedValue(undefined);

      const response = await updateProject(
        receiptRouteRequest(
          "PUT",
          `/projects/${world.projectId}`,
          {
            name: "Renamed",
            customFields: {
              [textFieldId]: "applied first",
              [enumFieldId]: randomUUID(),
            },
          },
          "toolu_refused"
        ),
        receiptRouteParams({ id: world.projectId })
      );

      expect(response.status).toBe(400);
      const stored = await withDb(async (db) => ({
        name: (
          await db.project.findUniqueOrThrow({
            where: { id: world.projectId },
            select: { name: true },
          })
        ).name,
        values: await db.customFieldValue.count({
          where: { entityId: world.projectId },
        }),
      }));
      expect(stored).toEqual({ name: "Test Project", values: 0 });
      expect(await readReceipts(world.organizationId)).toEqual([
        {
          operationKind: OperationKind.ProjectWrite,
          outcome: OperationReceiptOutcome.Rejected,
          changedFields: [],
          clientCallId: "toolu_refused",
          route: PROJECT_ROUTE,
        },
      ]);
    });
  }
);

function seedTextField(organizationId: string): Promise<string> {
  return seedField(organizationId, CustomFieldType.Text);
}

async function seedField(
  organizationId: string,
  fieldType: CustomFieldType
): Promise<string> {
  const field = await withDb((db) =>
    db.customField.create({
      data: {
        organizationId,
        name: `ISS-12552 ${fieldType} ${randomUUID()}`,
        fieldType,
        entityTypes: [CustomFieldEntityType.Project],
      },
    })
  );
  customFieldIds.add(field.id);
  return field.id;
}

function readReceipts(organizationId: string) {
  return withDb((db) =>
    db.artifactOperationReceipt.findMany({
      where: { organizationId },
      orderBy: { createdAt: "asc" },
      select: {
        operationKind: true,
        outcome: true,
        changedFields: true,
        clientCallId: true,
        route: true,
      },
    })
  );
}
