import {
  CustomFieldType,
  ReferenceTargetSource,
} from "@repo/api/src/types/custom-field";
import { CustomFieldQueryRejection } from "@repo/api/src/types/custom-field-list-query";
import { withDb } from "@repo/database";
import { keys } from "@repo/database/keys";
import { log } from "@repo/observability/log";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  autoRollbackTransaction,
  createTestOrganization,
} from "@/__tests__/utils/db-helpers";
import { customFieldsService } from "@/app/custom-fields/service";
import { CUSTOM_FIELD_UNREADABLE_OMITTED_EVENT } from "@/app/custom-fields/unreadable-field-telemetry";
import { getPrismaErrorCode, isUnknownEnumValueError } from "@/lib/db-utils";

/**
 * ISS-11071 AC3: the unknown-enum read against the real Prisma runtime and a
 * real Postgres, not a hand-built error.
 *
 * A rolling deploy is simulated by renaming one `CustomFieldType` label in the
 * database, so a row stored under it holds a value this build's generated
 * client has no member for. The rename runs inside the rolled-back
 * transaction every `withDb` call joins, so it never outlives the case.
 *
 * Needs a single-role database, which is what CI and a developer box run
 * today. The `ALTER TYPE` and `ALTER TABLE` below are owner DDL on the runtime
 * connection. Under the ISS-5978 split (`MIGRATE_DATABASE_URL` set, see
 * `__tests__/utils/fixture-db.ts`) the runtime role owns nothing, so every case
 * fails with 42501. The DDL cannot move to `withFixtureClient`: it has to sit
 * inside the rolled-back transaction the service under test joins.
 */
const hasDatabase = Boolean(keys().DATABASE_URL);

const UNKNOWN_LABEL = "ISS11071_FUTURE_TYPE";

async function seedFields(organizationId: string) {
  return await withDb(async (db) => {
    const readable = await db.customField.create({
      data: {
        organizationId,
        name: "Readable",
        fieldType: CustomFieldType.Text,
      },
    });
    const unreadable = await db.customField.create({
      data: {
        organizationId,
        name: "Unreadable",
        fieldType: CustomFieldType.Date,
      },
    });
    return { readable, unreadable };
  });
}

async function renameDateLabel() {
  await withDb((db) =>
    db.$executeRawUnsafe(
      `ALTER TYPE "CustomFieldType" RENAME VALUE '${CustomFieldType.Date}' TO '${UNKNOWN_LABEL}'`
    )
  );
}

describe.skipIf(!hasDatabase)(
  "customFieldsService.findByOrg with an unknown enum value (realdb)",
  () => {
    afterEach(() => {
      vi.restoreAllMocks();
    });

    it("returns the readable fields and omits the one this build cannot map", async () => {
      await autoRollbackTransaction(async () => {
        const organizationId = await createTestOrganization();
        const { readable } = await seedFields(organizationId);
        await renameDateLabel();

        // The runtime behaviour the fix is keyed on: the plain list read
        // rejects as a whole with P2023 and the enum message.
        const raw = await withDb((db) =>
          db.customField.findMany({ where: { organizationId } })
        ).then(
          () => null,
          (error: unknown) => error
        );
        expect(getPrismaErrorCode(raw)).toBe("P2023");
        expect(isUnknownEnumValueError(raw)).toBe(true);

        const fields = await customFieldsService.findByOrg(organizationId);

        expect(fields.map((field) => field.id)).toEqual([readable.id]);
      });
    });

    it("omits a field whose unknown value sits in a column other than fieldType, and names that enum", async () => {
      await autoRollbackTransaction(async () => {
        const organizationId = await createTestOrganization();
        const { readable, unreadable } = await withDb(async (db) => ({
          readable: await db.customField.create({
            data: {
              organizationId,
              name: "Linked issues",
              fieldType: CustomFieldType.Reference,
              referenceTargetSources: [ReferenceTargetSource.Issue],
            },
          }),
          unreadable: await db.customField.create({
            data: {
              organizationId,
              name: "Linked branches",
              fieldType: CustomFieldType.Reference,
              referenceTargetSources: [
                ReferenceTargetSource.Issue,
                ReferenceTargetSource.Branch,
              ],
            },
          }),
        }));
        await withDb((db) =>
          db.$executeRawUnsafe(
            `ALTER TYPE "ReferenceTargetSource" RENAME VALUE '${ReferenceTargetSource.Branch}' TO '${UNKNOWN_LABEL}'`
          )
        );
        const errorLog = vi.spyOn(log, "error");

        const fields = await customFieldsService.findByOrg(organizationId);

        expect(fields.map((field) => field.id)).toEqual([readable.id]);
        expect(errorLog).toHaveBeenCalledWith(
          CUSTOM_FIELD_UNREADABLE_OMITTED_EVENT,
          expect.objectContaining({
            customFieldId: unreadable.id,
            reason: CustomFieldQueryRejection.UnsupportedFieldType,
            enumReadError: expect.stringContaining(
              "not found in enum 'ReferenceTargetSource'"
            ),
          })
        );
      });
    });

    it("still fails loudly on a P2023 that is not an unknown enum value", async () => {
      await autoRollbackTransaction(async () => {
        const organizationId = await createTestOrganization();
        await seedFields(organizationId);
        // The same data mapper, the same P2023, a different message: an
        // integer column holding text.
        await withDb(async (db) => {
          await db.$executeRawUnsafe(
            "ALTER TABLE custom_fields ALTER COLUMN precision TYPE text"
          );
          await db.$executeRaw`UPDATE custom_fields SET precision = 'abc' WHERE organization_id = ${organizationId}::uuid`;
        });

        const error = await customFieldsService.findByOrg(organizationId).then(
          () => null,
          (raised: unknown) => raised
        );

        expect(getPrismaErrorCode(error)).toBe("P2023");
        expect(isUnknownEnumValueError(error)).toBe(false);
      });
    });
  }
);
