/**
 * Integration tests for `enumOptionsService.updateEnumOption`.
 *
 * Renaming an option re-derives the cached `displayValue` of every affected
 * CustomFieldValue with set-based statements: a Prisma `updateMany` for ENUM,
 * and raw SQL (`string_agg` over `unnest(...) WITH ORDINALITY`) for MULTI_ENUM.
 * The MULTI_ENUM statement's selection ordering, dangling-id handling, and
 * field scoping are Postgres behavior, so this suite runs against a real
 * database rather than asserting the query shape.
 */
import { randomUUID } from "node:crypto";
import {
  CustomFieldEntityType,
  CustomFieldType,
} from "@repo/api/src/types/custom-field";
import { withDb } from "@repo/database";
import { keys } from "@repo/database/keys";
import { describe, expect, it } from "vitest";
import { enumOptionsService } from "@/app/custom-fields/enum-options-service";
import { computeDisplayValue } from "@/app/custom-fields/utils";
import {
  autoRollbackTransaction,
  createTestOrganization,
} from "../utils/db-helpers";

// Skip integration tests if no DATABASE_URL is configured
const env = keys();
const hasDatabase = !!env.DATABASE_URL;

type SeededField = {
  fieldId: string;
  optionIds: string[];
};

/** Creates a custom field of the given type with one option per supplied name. */
async function seedField(
  organizationId: string,
  fieldType: CustomFieldType,
  optionNames: string[]
): Promise<SeededField> {
  const field = await withDb((db) =>
    db.customField.create({
      data: {
        organizationId,
        name: `Field ${randomUUID()}`,
        fieldType,
        entityTypes: [CustomFieldEntityType.Document],
        enumOptions: {
          create: optionNames.map((name, sortOrder) => ({ name, sortOrder })),
        },
      },
      include: { enumOptions: { orderBy: { sortOrder: "asc" } } },
    })
  );
  return {
    fieldId: field.id,
    optionIds: field.enumOptions.map((option) => option.id),
  };
}

/** Creates a value row for `fieldId` and returns its id. */
async function seedValue(
  organizationId: string,
  fieldId: string,
  value: { enumValueId?: string; multiEnumValueIds?: string[] },
  displayValue: string
): Promise<string> {
  const row = await withDb((db) =>
    db.customFieldValue.create({
      data: {
        customFieldId: fieldId,
        organizationId,
        entityType: CustomFieldEntityType.Document,
        entityId: randomUUID(),
        multiEnumValueIds: [],
        peopleValueIds: [],
        ...value,
        displayValue,
      },
    })
  );
  return row.id;
}

function readDisplayValue(valueId: string): Promise<string | null> {
  return withDb(async (db) => {
    const row = await db.customFieldValue.findUniqueOrThrow({
      where: { id: valueId },
      select: { displayValue: true },
    });
    return row.displayValue;
  });
}

describe.skipIf(!hasDatabase)("enumOptionsService.updateEnumOption", () => {
  it("re-derives every ENUM row's displayValue and leaves other options alone", async () => {
    await autoRollbackTransaction(async () => {
      const orgId = await createTestOrganization();
      const { fieldId, optionIds } = await seedField(
        orgId,
        CustomFieldType.Enum,
        ["High", "Low"]
      );
      const [highId, lowId] = optionIds;

      const renamedRows = await Promise.all([
        seedValue(orgId, fieldId, { enumValueId: highId }, "High"),
        seedValue(orgId, fieldId, { enumValueId: highId }, "High"),
      ]);
      const untouchedRow = await seedValue(
        orgId,
        fieldId,
        { enumValueId: lowId },
        "Low"
      );

      await enumOptionsService.updateEnumOption(highId, fieldId, orgId, {
        name: "Urgent",
      });

      expect(await readDisplayValue(renamedRows[0])).toBe("Urgent");
      expect(await readDisplayValue(renamedRows[1])).toBe("Urgent");
      expect(await readDisplayValue(untouchedRow)).toBe("Low");
    });
  });

  it("re-derives MULTI_ENUM displayValues in selection order, dropping ids with no option", async () => {
    await autoRollbackTransaction(async () => {
      const orgId = await createTestOrganization();
      const { fieldId, optionIds } = await seedField(
        orgId,
        CustomFieldType.MultiEnum,
        ["High", "Low"]
      );
      const [highId, lowId] = optionIds;
      const danglingId = randomUUID();

      const renamedFirst = await seedValue(
        orgId,
        fieldId,
        { multiEnumValueIds: [highId, lowId] },
        "High, Low"
      );
      const renamedSecond = await seedValue(
        orgId,
        fieldId,
        { multiEnumValueIds: [lowId, highId] },
        "Low, High"
      );
      const withDangling = await seedValue(
        orgId,
        fieldId,
        { multiEnumValueIds: [highId, danglingId] },
        "High"
      );
      const untouchedRow = await seedValue(
        orgId,
        fieldId,
        { multiEnumValueIds: [lowId] },
        "Low"
      );

      await enumOptionsService.updateEnumOption(highId, fieldId, orgId, {
        name: "Urgent",
      });

      // Selection order is preserved, not option sortOrder.
      expect(await readDisplayValue(renamedFirst)).toBe("Urgent, Low");
      expect(await readDisplayValue(renamedSecond)).toBe("Low, Urgent");
      // An id with no surviving option contributes nothing.
      expect(await readDisplayValue(withDangling)).toBe("Urgent");
      // A row that never selected the renamed option is not rewritten.
      expect(await readDisplayValue(untouchedRow)).toBe("Low");
    });
  });

  it("writes the same MULTI_ENUM string computeDisplayValue would produce", async () => {
    await autoRollbackTransaction(async () => {
      const orgId = await createTestOrganization();
      const { fieldId, optionIds } = await seedField(
        orgId,
        CustomFieldType.MultiEnum,
        ["High", "Low", "Medium"]
      );
      const [highId, lowId, mediumId] = optionIds;
      const selection = [mediumId, highId, lowId];
      const valueId = await seedValue(
        orgId,
        fieldId,
        { multiEnumValueIds: selection },
        "stale"
      );

      await enumOptionsService.updateEnumOption(highId, fieldId, orgId, {
        name: "Urgent",
      });

      const field = await withDb((db) =>
        db.customField.findUniqueOrThrow({
          where: { id: fieldId },
          include: { enumOptions: true },
        })
      );
      const expected = await computeDisplayValue(field, selection);

      expect(await readDisplayValue(valueId)).toBe(expected);
      expect(expected).toBe("Medium, Urgent, Low");
    });
  });

  it("advances updatedAt on the MULTI_ENUM rows it rewrites", async () => {
    await autoRollbackTransaction(async () => {
      const orgId = await createTestOrganization();
      const { fieldId, optionIds } = await seedField(
        orgId,
        CustomFieldType.MultiEnum,
        ["High"]
      );
      const valueId = await seedValue(
        orgId,
        fieldId,
        { multiEnumValueIds: optionIds },
        "High"
      );
      // Pin updatedAt to a sentinel the rename must move off of.
      await withDb(
        (db) =>
          db.$executeRaw`UPDATE "custom_field_values" SET "updated_at" = TIMESTAMP '2000-01-01 00:00:00' WHERE "id" = ${valueId}::uuid`
      );

      // `now()` would return the enclosing transaction's start time, which this
      // suite opens before the sentinel write — so a monotonic assertion from
      // here is exactly what a transaction-start timestamp fails.
      const beforeRename = new Date();
      await enumOptionsService.updateEnumOption(optionIds[0], fieldId, orgId, {
        name: "Urgent",
      });

      const row = await withDb((db) =>
        db.customFieldValue.findUniqueOrThrow({
          where: { id: valueId },
          select: { updatedAt: true },
        })
      );
      expect(row.updatedAt.getTime()).toBeGreaterThanOrEqual(
        beforeRename.getTime()
      );
    });
  });

  it("does not rewrite an ENUM row whose organization differs from the field's", async () => {
    await autoRollbackTransaction(async () => {
      const orgId = await createTestOrganization();
      const otherOrgId = await createTestOrganization();
      const { fieldId, optionIds } = await seedField(
        orgId,
        CustomFieldType.Enum,
        ["High"]
      );

      // `custom_field_values.organization_id` is independent of the field's, so
      // a mismatched row is schema-valid and must survive the rename untouched.
      const foreignOrgRow = await seedValue(
        otherOrgId,
        fieldId,
        { enumValueId: optionIds[0] },
        "High"
      );
      const inOrgRow = await seedValue(
        orgId,
        fieldId,
        { enumValueId: optionIds[0] },
        "High"
      );

      await enumOptionsService.updateEnumOption(optionIds[0], fieldId, orgId, {
        name: "Urgent",
      });

      expect(await readDisplayValue(inOrgRow)).toBe("Urgent");
      expect(await readDisplayValue(foreignOrgRow)).toBe("High");
    });
  });

  it("does not rewrite a MULTI_ENUM row whose organization differs from the field's", async () => {
    await autoRollbackTransaction(async () => {
      const orgId = await createTestOrganization();
      const otherOrgId = await createTestOrganization();
      const { fieldId, optionIds } = await seedField(
        orgId,
        CustomFieldType.MultiEnum,
        ["High"]
      );

      const foreignOrgRow = await seedValue(
        otherOrgId,
        fieldId,
        { multiEnumValueIds: optionIds },
        "High"
      );
      const inOrgRow = await seedValue(
        orgId,
        fieldId,
        { multiEnumValueIds: optionIds },
        "High"
      );

      await enumOptionsService.updateEnumOption(optionIds[0], fieldId, orgId, {
        name: "Urgent",
      });

      expect(await readDisplayValue(inOrgRow)).toBe("Urgent");
      expect(await readDisplayValue(foreignOrgRow)).toBe("High");
    });
  });

  it("ignores selected ids that belong to another field's options", async () => {
    await autoRollbackTransaction(async () => {
      const orgId = await createTestOrganization();
      const renamed = await seedField(orgId, CustomFieldType.MultiEnum, [
        "High",
      ]);
      const foreign = await seedField(orgId, CustomFieldType.MultiEnum, [
        "Foreign",
      ]);
      const valueId = await seedValue(
        orgId,
        renamed.fieldId,
        { multiEnumValueIds: [renamed.optionIds[0], foreign.optionIds[0]] },
        "High"
      );

      await enumOptionsService.updateEnumOption(
        renamed.optionIds[0],
        renamed.fieldId,
        orgId,
        { name: "Urgent" }
      );

      // computeDisplayValue resolves names only from this field's own options,
      // so an id owned by another field contributes nothing.
      expect(await readDisplayValue(valueId)).toBe("Urgent");
    });
  });

  it("does not rewrite value rows belonging to a different custom field", async () => {
    await autoRollbackTransaction(async () => {
      const orgId = await createTestOrganization();
      const renamed = await seedField(orgId, CustomFieldType.MultiEnum, [
        "High",
      ]);
      const other = await seedField(orgId, CustomFieldType.MultiEnum, ["High"]);

      // A row on `other` that (impossibly, but the WHERE must still scope for
      // it) names the renamed field's option id.
      const otherFieldRow = await seedValue(
        orgId,
        other.fieldId,
        { multiEnumValueIds: renamed.optionIds },
        "High"
      );

      await enumOptionsService.updateEnumOption(
        renamed.optionIds[0],
        renamed.fieldId,
        orgId,
        { name: "Urgent" }
      );

      expect(await readDisplayValue(otherFieldRow)).toBe("High");
    });
  });

  it("rejects a rename for a field owned by another organization", async () => {
    await autoRollbackTransaction(async () => {
      const orgId = await createTestOrganization();
      const otherOrgId = await createTestOrganization();
      const { fieldId, optionIds } = await seedField(
        orgId,
        CustomFieldType.Enum,
        ["High"]
      );

      await expect(
        enumOptionsService.updateEnumOption(optionIds[0], fieldId, otherOrgId, {
          name: "Urgent",
        })
      ).rejects.toThrow(
        "Custom field not found or does not belong to organization"
      );
    });
  });
});
