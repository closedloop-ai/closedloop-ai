/**
 * ISS-7215 acceptance: renaming a user changes what a PEOPLE custom field
 * renders, with NO write to `custom_field_values`.
 *
 * This is the regression test the ticket exists for, and the only one that fails
 * against `main`: it renames the user directly in the database — the way a
 * profile edit or an identity-provider sync does, touching no custom-field code
 * — and then reads the value back through the real service. Under
 * `CachedOnWrite` the read returns the OLD name.
 *
 * It also pins the half of the design that is easy to "tidy" away: the stored
 * column must still hold the pre-rename string after a RAW rename. That is what
 * proves the render fix is "the column is no longer authoritative" rather than
 * "the column got refreshed", and the column has to stay populated because
 * `documents/custom-field-list-query.ts` orders PEOPLE by it.
 *
 * ISS-8970 added the other half: a rename through a production writer
 * (`usersService.upsertByClerkIdAndOrg`, `updateByClerkId`) DOES refresh the
 * column, so the PEOPLE sort follows the new name with no custom-field write.
 * The last case here is that proof; the raw-rename case above stays as the
 * render proof, because raw SQL bypasses every service writer.
 */
import { randomUUID } from "node:crypto";
import {
  CustomFieldEntityType,
  CustomFieldType,
} from "@repo/api/src/types/custom-field";
import { CustomFieldSortDirection } from "@repo/api/src/types/custom-field-list-query";
import { DocumentStatus } from "@repo/api/src/types/document";
import { ArtifactSubtype, ArtifactType, withDb } from "@repo/database";
import { keys } from "@repo/database/keys";
import { describe, expect, it } from "vitest";
import {
  autoRollbackTransaction,
  createTestOrganization,
  createTestUser,
} from "@/__tests__/utils/db-helpers";
import { customFieldValuesService } from "@/app/custom-fields/values-service";
import { customFieldListService } from "@/app/documents/custom-field-list-service";
import { usersService } from "@/app/users/service";

const env = keys();
const hasDatabase = !!env.DATABASE_URL;

/** A DOCUMENT artifact to hang the value on, so `verifyEntityExists` passes. */
async function seedDocumentArtifact(organizationId: string): Promise<string> {
  const artifact = await withDb((db) =>
    db.artifact.create({
      data: {
        organizationId,
        type: ArtifactType.DOCUMENT,
        subtype: ArtifactSubtype.FEATURE,
        status: DocumentStatus.Draft,
        name: `Doc ${randomUUID()}`,
      },
    })
  );
  return artifact.id;
}

async function seedPeopleField(organizationId: string): Promise<string> {
  const field = await withDb((db) =>
    db.customField.create({
      data: {
        organizationId,
        name: `Owner ${randomUUID()}`,
        fieldType: CustomFieldType.People,
        entityTypes: [CustomFieldEntityType.Document],
      },
    })
  );
  return field.id;
}

/** The raw cached column, read behind the service so the projection cannot mask it. */
function readStoredDisplayValue(
  fieldId: string,
  entityId: string
): Promise<string | null> {
  return withDb(async (db) => {
    const row = await db.customFieldValue.findFirstOrThrow({
      where: { customFieldId: fieldId, entityId },
      select: { displayValue: true },
    });
    return row.displayValue;
  });
}

describe.skipIf(!hasDatabase)(
  "PEOPLE custom field display value after a rename (ISS-7215)",
  () => {
    it("renders the NEW name while the cached column still holds the OLD one", async () => {
      await autoRollbackTransaction(async () => {
        const organizationId = await createTestOrganization();
        const user = await createTestUser(organizationId, {
          firstName: "Tamsin",
          lastName: "Bramley",
        });
        const fieldId = await seedPeopleField(organizationId);
        const entityId = await seedDocumentArtifact(organizationId);

        const written = await customFieldValuesService.setValueForEntity(
          fieldId,
          CustomFieldEntityType.Document,
          entityId,
          organizationId,
          [user.id]
        );
        expect(written.displayValue).toBe("Tamsin B.");

        // The rename. Note what is NOT touched: no custom-field write, no
        // cascade, nothing that would refresh the cached column.
        await withDb((db) =>
          db.user.update({
            where: { id: user.id },
            data: { lastName: "Test" },
          })
        );

        const [reread] = await customFieldValuesService.getValuesForEntity(
          CustomFieldEntityType.Document,
          entityId,
          organizationId
        );

        // Against `main` this is still "Tamsin B.".
        expect(reread.displayValue).toBe("Tamsin T.");
        expect(reread.peopleValues.map((p) => p.lastName)).toEqual(["Test"]);

        // The cached column is stale here ONLY because the rename above bypassed
        // every service writer (raw `db.user.update`). It is still the sort key;
        // the production rename paths refresh it (last case in this file), and
        // this case proves the read no longer depends on it either way.
        expect(await readStoredDisplayValue(fieldId, entityId)).toBe(
          "Tamsin B."
        );
      });
    });

    it("keeps the stored column NON-EMPTY for PEOPLE, unlike a reference value", async () => {
      // PEOPLE takes only half of REFERENCE's ResolvedOnRead treatment. Blanking
      // this column would send every PEOPLE row through `NULLIF(…,'')` into one
      // `NULLS LAST` bucket and serve creation order under the reader's chosen
      // column. No unit test can catch that: `custom-field-list-query.test.ts`
      // pins the sort SOURCE, which stays green when the column goes empty.
      await autoRollbackTransaction(async () => {
        const organizationId = await createTestOrganization();
        const user = await createTestUser(organizationId, {
          firstName: "Ada",
          lastName: "Lovelace",
        });
        const fieldId = await seedPeopleField(organizationId);
        const entityId = await seedDocumentArtifact(organizationId);

        await customFieldValuesService.setValueForEntity(
          fieldId,
          CustomFieldEntityType.Document,
          entityId,
          organizationId,
          [user.id]
        );

        expect(await readStoredDisplayValue(fieldId, entityId)).toBe("Ada L.");
      });
    });

    it("orders both the rendered string and the projected users by the stored ids", async () => {
      await autoRollbackTransaction(async () => {
        const organizationId = await createTestOrganization();
        const ada = await createTestUser(organizationId, {
          firstName: "Ada",
          lastName: "Lovelace",
        });
        const alan = await createTestUser(organizationId, {
          firstName: "Alan",
          lastName: "Turing",
        });
        const fieldId = await seedPeopleField(organizationId);
        const entityId = await seedDocumentArtifact(organizationId);

        // Deliberately not creation order, so a path that leaned on the
        // database's own row order would disagree.
        const written = await customFieldValuesService.setValueForEntity(
          fieldId,
          CustomFieldEntityType.Document,
          entityId,
          organizationId,
          [alan.id, ada.id]
        );

        expect(written.displayValue).toBe("Alan T., Ada L.");
        expect(await readStoredDisplayValue(fieldId, entityId)).toBe(
          "Alan T., Ada L."
        );

        const [reread] = await customFieldValuesService.getValuesForEntity(
          CustomFieldEntityType.Document,
          entityId,
          organizationId
        );
        expect(reread.displayValue).toBe("Alan T., Ada L.");
        expect(reread.peopleValues.map((p) => p.id)).toEqual([alan.id, ada.id]);
      });
    });

    it("sorts by the NEW name after a rename through a production writer, with no custom-field write (ISS-8970)", async () => {
      await autoRollbackTransaction(async () => {
        const organizationId = await createTestOrganization();
        const early = await createTestUser(organizationId, {
          firstName: "Ada",
          lastName: "Lovelace",
        });
        const late = await createTestUser(organizationId, {
          firstName: "Zoe",
          lastName: "Zimmer",
        });
        const fieldId = await seedPeopleField(organizationId);
        const earlyDoc = await seedDocumentArtifact(organizationId);
        const lateDoc = await seedDocumentArtifact(organizationId);
        await customFieldValuesService.setValueForEntity(
          fieldId,
          CustomFieldEntityType.Document,
          earlyDoc,
          organizationId,
          [early.id]
        );
        await customFieldValuesService.setValueForEntity(
          fieldId,
          CustomFieldEntityType.Document,
          lateDoc,
          organizationId,
          [late.id]
        );

        const orderAsc = () =>
          customFieldListService.orderIdsByCustomField(
            [lateDoc, earlyDoc],
            {
              id: fieldId,
              fieldType: CustomFieldType.People,
              isSortable: true,
              isSearchable: true,
            },
            { fieldId, direction: CustomFieldSortDirection.Asc },
            CustomFieldEntityType.Document,
            organizationId,
            undefined,
            0
          );
        expect(await orderAsc()).toEqual([earlyDoc, lateDoc]);

        // The rename, through the Clerk user.updated writer. Nothing touches
        // custom-field code.
        await usersService.updateByClerkId(
          late.clerkId,
          { firstName: "Aaron", lastName: "Aardvark" },
          new Date("2026-01-01T00:00:00Z")
        );

        // "Aaron A." now sorts ahead of "Ada L.", and the column says so.
        expect(await orderAsc()).toEqual([lateDoc, earlyDoc]);
        expect(await readStoredDisplayValue(fieldId, lateDoc)).toBe("Aaron A.");
      });
    });
  }
);
