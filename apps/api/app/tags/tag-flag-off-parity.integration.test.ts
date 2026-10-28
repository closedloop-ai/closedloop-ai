import { CustomFieldType } from "@repo/api/src/types/custom-field";
import { TagColor, TagEntityType } from "@repo/api/src/types/tag";
import { withDb } from "@repo/database";
import { keys } from "@repo/database/keys";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  apiKeyRouteRequest,
  countReceipts,
  createReceiptRouteHarness,
  receiptRouteParams,
  turnAttributionFlagOff,
  turnAttributionFlagOn,
} from "@/__tests__/support/lib/operation-receipt-route.test-helpers";
import { countTransactions } from "@/__tests__/support/lib/transaction-count.test-helpers";

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
// The admin gate reads the caller's Clerk role; it is not under test here.
vi.mock("@/app/custom-fields/custom-fields-admin-gate", () => ({
  requireCustomFieldsAdmin: async () => null,
}));

import { PUT as updateOption } from "@/app/custom-fields/[id]/enum-options/[optionId]/route";
import { POST as reorderOptions } from "@/app/custom-fields/[id]/enum-options/reorder/route";
import { POST as createOption } from "@/app/custom-fields/[id]/enum-options/route";
import { PUT as updateField } from "@/app/custom-fields/[id]/route";
import { enumOptionsService } from "@/app/custom-fields/enum-options-service";
import { customFieldsService } from "@/app/custom-fields/service";
import {
  POST as applyEntityTag,
  DELETE as removeEntityTag,
} from "@/app/entity-tags/route";
import { DELETE as deleteTag, PATCH as updateTag } from "@/app/tags/[id]/route";
import { POST as createTag } from "@/app/tags/route";

const harness = createReceiptRouteHarness();
const organizationIds: string[] = [];
type World = Awaited<ReturnType<typeof harness.seedWorld>>;

/**
 * ISS-12552: flag-off behavior equals main for tag and custom field
 * definition writes. With `attribution-evidence-policy` off, each runs exactly
 * as it does on main.
 */
describe.skipIf(!keys().DATABASE_URL)(
  "ISS-12552 tag and custom field definition writes match main with attribution evidence off",
  () => {
    afterEach(async () => {
      vi.restoreAllMocks();
      const orgIds = organizationIds.splice(0);
      await withDb(async (db) => {
        await db.tag.deleteMany({ where: { organizationId: { in: orgIds } } });
        await db.customField.deleteMany({
          where: { organizationId: { in: orgIds } },
        });
      });
      await harness.cleanup();
    });

    it("a tag create, rename and delete each open no transaction, as on main", async () => {
      await seedWorld();
      turnAttributionFlagOff();
      const transactions = countTransactions();

      const created = await createTag(
        apiKeyRouteRequest("POST", "/tags", { name: "Parity" }),
        receiptRouteParams({})
      );
      const tagId = ((await created.json()) as { data: { id: string } }).data
        .id;
      const renamed = await updateTag(
        apiKeyRouteRequest("PATCH", `/tags/${tagId}`, { name: "Renamed" }),
        receiptRouteParams({ id: tagId })
      );
      const deleted = await deleteTag(
        apiKeyRouteRequest("DELETE", `/tags/${tagId}`),
        receiptRouteParams({ id: tagId })
      );

      expect([created.status, renamed.status, deleted.status]).toEqual([
        200, 200, 200,
      ]);
      expect(transactions.calls).toBe(0);
      expect(await countTags(tagId)).toBe(0);
    });

    it("removing a tag from a project opens no transaction, as on main", async () => {
      const world = await seedWorld();
      const tagId = await seedTag(world);
      turnAttributionFlagOff();
      const applied = await applyEntityTag(
        apiKeyRouteRequest("POST", "/entity-tags", {
          tagId,
          entityType: TagEntityType.Project,
          entityId: world.projectId,
        }),
        receiptRouteParams({})
      );
      const transactions = countTransactions();

      const removed = await removeEntityTag(
        apiKeyRouteRequest(
          "DELETE",
          `/entity-tags?tagId=${tagId}&entityType=${TagEntityType.Project}&entityId=${world.projectId}`
        ),
        receiptRouteParams({})
      );

      expect([applied.status, removed.status]).toEqual([200, 200]);
      expect(transactions.calls).toBe(0);
      expect(
        await withDb((db) =>
          db.tagProject.count({ where: { tagId, projectId: world.projectId } })
        )
      ).toBe(0);
      expect(await countReceipts(world.organizationId)).toBe(0);
    });

    it("an enum option create opens no transaction, as on main", async () => {
      const world = await seedWorld();
      const field = await seedEnumField(world);
      turnAttributionFlagOff();
      const transactions = countTransactions();

      const response = await createOption(
        apiKeyRouteRequest("POST", `/custom-fields/${field.id}/enum-options`, {
          name: "Gamma",
        }),
        receiptRouteParams({ id: field.id })
      );

      expect(response.status).toBe(200);
      expect(transactions.calls).toBe(0);
      expect(
        await withDb((db) =>
          db.customFieldEnumOption.count({ where: { customFieldId: field.id } })
        )
      ).toBe(3);
    });

    it("a reorder rewrites every listed option, including those already in place, as on main", async () => {
      const world = await seedWorld();
      const field = await seedEnumField(world);
      turnAttributionFlagOff();
      const before = await readRowVersions(field.optionIds);

      const response = await reorderOptions(
        apiKeyRouteRequest(
          "POST",
          `/custom-fields/${field.id}/enum-options/reorder`,
          { optionIds: field.optionIds }
        ),
        receiptRouteParams({ id: field.id })
      );

      expect(response.status).toBe(200);
      // Main's UPDATE matches every listed option, so each row gets a new
      // version even when its sort order did not move.
      const after = await readRowVersions(field.optionIds);
      expect(after.map((version, index) => version !== before[index])).toEqual([
        true,
        true,
      ]);
    });

    it("a field or option update is handed no record, so it reads no before image", async () => {
      const world = await seedWorld();
      const field = await seedEnumField(world);
      turnAttributionFlagOff();
      const updateFieldSpy = vi.spyOn(customFieldsService, "updateField");
      const updateOptionSpy = vi.spyOn(enumOptionsService, "updateEnumOption");

      const fieldResponse = await updateField(
        apiKeyRouteRequest("PUT", `/custom-fields/${field.id}`, {
          showInTable: true,
        }),
        receiptRouteParams({ id: field.id })
      );
      const optionId = field.optionIds[0] ?? "";
      const optionResponse = await updateOption(
        apiKeyRouteRequest(
          "PUT",
          `/custom-fields/${field.id}/enum-options/${optionId}`,
          { color: "red" }
        ),
        receiptRouteParams({ id: field.id, optionId })
      );

      expect([fieldResponse.status, optionResponse.status]).toEqual([200, 200]);
      expect(updateFieldSpy).toHaveBeenCalledTimes(1);
      expect(updateOptionSpy).toHaveBeenCalledTimes(1);
      const [fieldCall] = updateFieldSpy.mock.calls;
      const [optionCall] = updateOptionSpy.mock.calls;
      // The route passes the record slot on every call, so its absence here
      // is the flag-off answer and not a shorter argument list.
      expect(fieldCall).toHaveLength(4);
      expect(optionCall).toHaveLength(5);
      expect(fieldCall?.[3]).toBeUndefined();
      expect(optionCall?.[4]).toBeUndefined();
      expect(await readStoredField(field.id, optionId)).toEqual({
        showInTable: true,
        color: "red",
      });

      // Control: with the flag on, the same slot carries the receipt write.
      turnAttributionFlagOn();
      await updateField(
        apiKeyRouteRequest("PUT", `/custom-fields/${field.id}`, {
          showInTable: false,
        }),
        receiptRouteParams({ id: field.id })
      );
      await updateOption(
        apiKeyRouteRequest(
          "PUT",
          `/custom-fields/${field.id}/enum-options/${optionId}`,
          { color: "blue" }
        ),
        receiptRouteParams({ id: field.id, optionId })
      );
      expect(updateFieldSpy.mock.calls[1]?.[3]).toBeTypeOf("function");
      expect(updateOptionSpy.mock.calls[1]?.[4]).toBeTypeOf("function");
    });
  }
);

async function seedWorld(): Promise<World> {
  const world = await harness.seedWorld();
  organizationIds.push(world.organizationId);
  return world;
}

async function seedTag(world: World): Promise<string> {
  const tag = await withDb((db) =>
    db.tag.create({
      data: {
        organizationId: world.organizationId,
        createdById: world.userId,
        name: "Parity tag",
        color: TagColor.Red,
      },
      select: { id: true },
    })
  );
  return tag.id;
}

async function readStoredField(fieldId: string, optionId: string) {
  const [field, option] = await withDb((db) =>
    Promise.all([
      db.customField.findUniqueOrThrow({
        where: { id: fieldId },
        select: { showInTable: true },
      }),
      db.customFieldEnumOption.findUniqueOrThrow({
        where: { id: optionId },
        select: { color: true },
      }),
    ])
  );
  return { showInTable: field.showInTable, color: option.color };
}

function countTags(tagId: string): Promise<number> {
  return withDb((db) => db.tag.count({ where: { id: tagId } }));
}

/** An ENUM field with options Alpha then Beta, written without a receipt. */
async function seedEnumField(world: World) {
  const field = await withDb((db) =>
    db.customField.create({
      data: {
        organizationId: world.organizationId,
        createdById: world.userId,
        name: "Parity enum",
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

/** Each option row's version (`xmin`), in the order given. */
async function readRowVersions(optionIds: string[]): Promise<string[]> {
  const rows = await withDb(
    (db) => db.$queryRaw<{ id: string; version: string }[]>`
      SELECT "id"::text AS id, xmin::text AS version
        FROM "custom_field_enum_options"
       WHERE "id" = ANY(${optionIds}::uuid[])`
  );
  const byId = new Map(rows.map((row) => [row.id, row.version]));
  return optionIds.map((id) => byId.get(id) ?? "");
}
