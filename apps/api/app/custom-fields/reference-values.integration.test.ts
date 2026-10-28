import {
  CustomFieldEntityType,
  CustomFieldType,
  ReferenceTargetSource,
} from "@repo/api/src/types/custom-field";
import { ArtifactSubtype, ArtifactType, withDb } from "@repo/database";
import { keys } from "@repo/database/keys";
import { describe, expect, it } from "vitest";
import {
  autoRollbackTransactionJoining,
  createTestOrganization,
  createTestUser,
} from "@/__tests__/utils/db-helpers";
import { InvalidReferenceTargetError } from "@/app/custom-fields/reference-targets";
import { customFieldsService } from "@/app/custom-fields/service";
import {
  createCustomFieldValidator,
  updateCustomFieldValidator,
} from "@/app/custom-fields/validators";
import { customFieldValuesService } from "@/app/custom-fields/values-service";

/**
 * ISS-11104 — this suite lets its ambient transaction absorb the nested
 * `withDb.tx` its production path opens, discarding that call's own budget.
 * The reason below is the whole statement: it is what a reviewer reads to tell
 * a suite that does not need the real boundary from one that is blind to it.
 */
const joinAmbientTransaction = autoRollbackTransactionJoining(
  "these cases pin how custom-field reference values resolve and refresh, not the commit boundary the field-update transaction opens"
);

/**
 * DB-backed coverage for REFERENCE custom fields (ISS-7208) and their
 * resolve-on-read display rule (ISS-7214).
 *
 * A real database is the point, not incidental. Two of the guarantees under
 * test are enforced by Postgres rather than by application code — the
 * `ON DELETE CASCADE` from `custom_field_value_references.target_artifact_id`
 * to `artifacts`, and the absence of any cached string to go stale. A mocked
 * `withDb` cannot produce either, so a fake-backed sibling suite would report
 * green against a schema that had neither the FK nor the cascade.
 */

const hasDatabase = Boolean(keys().DATABASE_URL);
const describeIfDb = hasDatabase ? describe : describe.skip;

type Scope = {
  organizationId: string;
  userId: string;
  ownerDocumentId: string;
  issueArtifactId: string;
  sessionArtifactId: string;
  fieldId: string;
};

async function seedIssueReferenceField(
  fieldType: (typeof CustomFieldType)[keyof typeof CustomFieldType] = CustomFieldType.Reference,
  sources: ReferenceTargetSource[] = [ReferenceTargetSource.Issue]
): Promise<Scope> {
  const organizationId = await createTestOrganization();
  const user = await createTestUser(organizationId);

  const [ownerDocument, issueArtifact, sessionArtifact] = await withDb((db) =>
    Promise.all([
      db.artifact.create({
        data: {
          organizationId,
          type: ArtifactType.DOCUMENT,
          subtype: ArtifactSubtype.PRD,
          status: "DRAFT",
          name: "Owning PRD",
          slug: "PRD-900",
          createdById: user.id,
        },
      }),
      db.artifact.create({
        data: {
          organizationId,
          type: ArtifactType.DOCUMENT,
          subtype: ArtifactSubtype.FEATURE,
          status: "TODO",
          name: "Original issue title",
          slug: "ISS-4382",
          createdById: user.id,
        },
      }),
      db.artifact.create({
        data: {
          organizationId,
          type: ArtifactType.SESSION,
          status: "active",
          name: "A session",
          createdById: user.id,
        },
      }),
    ])
  );

  const field = await withDb((db) =>
    db.customField.create({
      data: {
        organizationId,
        name: `Parent artifact ${Date.now()}`,
        fieldType,
        referenceTargetSources: sources,
        entityTypes: [CustomFieldEntityType.Document],
      },
    })
  );

  return {
    organizationId,
    userId: user.id,
    ownerDocumentId: ownerDocument.id,
    issueArtifactId: issueArtifact.id,
    sessionArtifactId: sessionArtifact.id,
    fieldId: field.id,
  };
}

function readValues(scope: Scope) {
  return customFieldValuesService.getValuesForEntity(
    CustomFieldEntityType.Document,
    scope.ownerDocumentId,
    scope.organizationId
  );
}

function writeReference(scope: Scope, value: string | string[]) {
  return customFieldValuesService.setValueForEntity(
    scope.fieldId,
    CustomFieldEntityType.Document,
    scope.ownerDocumentId,
    scope.organizationId,
    value
  );
}

describeIfDb("REFERENCE custom field values", () => {
  it("writes a reference and reads the target back through the API", async () => {
    await joinAmbientTransaction(async () => {
      const scope = await seedIssueReferenceField();

      await writeReference(scope, scope.issueArtifactId);

      const [value] = await readValues(scope);
      expect(value.fieldType).toBe(CustomFieldType.Reference);
      expect(value.referenceValues).toHaveLength(1);
      expect(value.referenceValues[0]).toMatchObject({
        id: scope.issueArtifactId,
        slug: "ISS-4382",
        name: "Original issue title",
      });
    });
  });

  it("rejects a target whose type the field does not permit, and stores nothing", async () => {
    await joinAmbientTransaction(async () => {
      // Field is sourced to Issues; a SESSION artifact is a legal artifact id
      // but an illegal value for this field.
      const scope = await seedIssueReferenceField();

      await expect(
        writeReference(scope, scope.sessionArtifactId)
      ).rejects.toBeInstanceOf(InvalidReferenceTargetError);

      // The rejection must be a rejection, not a rollback of the visible half:
      // no value row, and no reference row, may survive it.
      const stored = await readValues(scope);
      expect(stored).toHaveLength(0);

      const referenceRows = await withDb((db) =>
        db.customFieldValueReference.count({
          where: { targetArtifactId: scope.sessionArtifactId },
        })
      );
      expect(referenceRows).toBe(0);
    });
  });

  it("rejects a second target on a single-cardinality REFERENCE field", async () => {
    await joinAmbientTransaction(async () => {
      const scope = await seedIssueReferenceField(CustomFieldType.Reference, [
        ReferenceTargetSource.Artifact,
      ]);

      await expect(
        writeReference(scope, [scope.issueArtifactId, scope.sessionArtifactId])
      ).rejects.toBeInstanceOf(InvalidReferenceTargetError);
    });
  });

  it("rejects a target that does not exist", async () => {
    await joinAmbientTransaction(async () => {
      const scope = await seedIssueReferenceField();

      await expect(
        writeReference(scope, "00000000-0000-7000-8000-000000000000")
      ).rejects.toBeInstanceOf(InvalidReferenceTargetError);
    });
  });

  it("rejects an artifact belonging to another organization", async () => {
    await joinAmbientTransaction(async () => {
      const scope = await seedIssueReferenceField(CustomFieldType.Reference, [
        ReferenceTargetSource.Artifact,
      ]);

      // A second tenant with an artifact that would otherwise satisfy the
      // source contract. Cross-org reachability is the thing under test, so it
      // is seeded rather than mocked.
      const otherOrgId = await createTestOrganization();
      const otherUser = await createTestUser(otherOrgId);
      const foreign = await withDb((db) =>
        db.artifact.create({
          data: {
            organizationId: otherOrgId,
            type: ArtifactType.DOCUMENT,
            subtype: ArtifactSubtype.FEATURE,
            status: "TODO",
            name: "Someone else's issue",
            slug: "ISS-7777",
            createdById: otherUser.id,
          },
        })
      );

      await expect(writeReference(scope, foreign.id)).rejects.toBeInstanceOf(
        InvalidReferenceTargetError
      );

      const rows = await withDb((db) =>
        db.customFieldValueReference.count({
          where: { targetArtifactId: foreign.id },
        })
      );
      expect(rows).toBe(0);
    });
  });

  it("rejects a self-reference", async () => {
    await joinAmbientTransaction(async () => {
      const scope = await seedIssueReferenceField(CustomFieldType.Reference, [
        ReferenceTargetSource.Artifact,
      ]);

      await expect(
        writeReference(scope, scope.ownerDocumentId)
      ).rejects.toBeInstanceOf(InvalidReferenceTargetError);
    });
  });

  it("accepts many targets on a REFERENCE_MULTI field and preserves their order", async () => {
    await joinAmbientTransaction(async () => {
      const scope = await seedIssueReferenceField(
        CustomFieldType.ReferenceMulti,
        [ReferenceTargetSource.Artifact]
      );

      await writeReference(scope, [
        scope.sessionArtifactId,
        scope.issueArtifactId,
      ]);

      const [value] = await readValues(scope);
      expect(value.referenceValues.map((t) => t.id)).toEqual([
        scope.sessionArtifactId,
        scope.issueArtifactId,
      ]);
    });
  });
});

describe("createCustomFieldValidator — referenceTargetSources", () => {
  // Pure Zod parses, so they belong outside the DB gate: the arm each one
  // covers is what keeps `isTargetAllowed`'s fail-closed branch unreachable,
  // and that guarantee must be checked on a machine with no database too.
  it("rejects a reference field created with no target sources", () => {
    const result = createCustomFieldValidator.safeParse({
      name: "Sourceless",
      fieldType: CustomFieldType.Reference,
      entityTypes: [CustomFieldEntityType.Document],
    });

    expect(result.success).toBe(false);
    expect(result.error?.issues).toHaveLength(1);
    expect(result.error?.issues[0]?.path).toEqual(["referenceTargetSources"]);
    expect(result.error?.issues[0]?.message).toBe(
      `A ${CustomFieldType.Reference} field must declare at least one target source.`
    );
  });

  it("rejects target sources on a non-reference field", () => {
    const result = createCustomFieldValidator.safeParse({
      name: "Plain text",
      fieldType: CustomFieldType.Text,
      referenceTargetSources: [ReferenceTargetSource.Issue],
      entityTypes: [CustomFieldEntityType.Document],
    });

    expect(result.success).toBe(false);
    expect(result.error?.issues).toHaveLength(1);
    expect(result.error?.issues[0]?.path).toEqual(["referenceTargetSources"]);
    expect(result.error?.issues[0]?.message).toBe(
      `referenceTargetSources is only valid for ${CustomFieldType.Reference} and ${CustomFieldType.ReferenceMulti} fields, not ${CustomFieldType.Text}.`
    );
  });

  it("accepts a non-reference field that declares no target sources", () => {
    // The positive control for the arm above. Without it, widening the
    // sources-required check to every field type leaves both rejections green
    // while every TEXT, NUMBER and ENUM field becomes uncreatable.
    const result = createCustomFieldValidator.safeParse({
      name: "Plain text",
      fieldType: CustomFieldType.Text,
      entityTypes: [CustomFieldEntityType.Document],
    });

    expect(result.success).toBe(true);
  });
});

describeIfDb(
  "reference field DEFINITION round-trips through the service",
  () => {
    // The suites above seed CustomField rows directly, which is exactly why the
    // create/update path could drop `referenceTargetSources` unnoticed: Zod
    // strips undeclared keys, so a field created through the API accepted every
    // artifact type. These drive the real validator + service instead.

    it("persists and reads back the declared target sources", async () => {
      await joinAmbientTransaction(async () => {
        const organizationId = await createTestOrganization();
        const user = await createTestUser(organizationId);

        const parsed = createCustomFieldValidator.parse({
          name: `Parent artifact ${Date.now()}`,
          fieldType: CustomFieldType.Reference,
          referenceTargetSources: [ReferenceTargetSource.Issue],
          entityTypes: [CustomFieldEntityType.Document],
        });

        const created = await customFieldsService.createField(
          organizationId,
          user.id,
          parsed
        );
        expect(created.referenceTargetSources).toEqual([
          ReferenceTargetSource.Issue,
        ]);

        const reread = await customFieldsService.findById(
          created.id,
          organizationId
        );
        expect(reread?.referenceTargetSources).toEqual([
          ReferenceTargetSource.Issue,
        ]);
      });
    });

    it("applies an updated source list", async () => {
      await joinAmbientTransaction(async () => {
        const organizationId = await createTestOrganization();
        const user = await createTestUser(organizationId);

        const created = await customFieldsService.createField(
          organizationId,
          user.id,
          createCustomFieldValidator.parse({
            name: `Linked ${Date.now()}`,
            fieldType: CustomFieldType.ReferenceMulti,
            referenceTargetSources: [ReferenceTargetSource.Issue],
            entityTypes: [CustomFieldEntityType.Document],
          })
        );

        const updated = await customFieldsService.updateField(
          created.id,
          organizationId,
          updateCustomFieldValidator.parse({
            referenceTargetSources: [
              ReferenceTargetSource.Session,
              ReferenceTargetSource.Branch,
            ],
          })
        );

        expect(updated.referenceTargetSources).toEqual([
          ReferenceTargetSource.Session,
          ReferenceTargetSource.Branch,
        ]);
      });
    });

    it("rejects clearing an existing field's sources to an empty list", () => {
      expect(() =>
        updateCustomFieldValidator.parse({ referenceTargetSources: [] })
      ).toThrow();
    });
  }
);

describeIfDb("REFERENCE displayValue is resolved on read (ISS-7214)", () => {
  it("renders a renamed target's new title on the next read, with no write to the referencing row", async () => {
    await joinAmbientTransaction(async () => {
      const scope = await seedIssueReferenceField();
      await writeReference(scope, scope.issueArtifactId);

      const [before] = await readValues(scope);
      expect(before.referenceValues[0].name).toBe("Original issue title");

      // Rename the TARGET only. Nothing touches custom_field_values.
      await withDb((db) =>
        db.artifact.update({
          where: { id: scope.issueArtifactId },
          data: { name: "Renamed issue title", slug: "ISS-9999" },
        })
      );

      const [after] = await readValues(scope);
      expect(after.referenceValues[0].name).toBe("Renamed issue title");
      expect(after.referenceValues[0].slug).toBe("ISS-9999");
      expect(after.displayValue).toBe("ISS-9999");
    });
  });

  it("never persists a display string for a reference value", async () => {
    await joinAmbientTransaction(async () => {
      const scope = await seedIssueReferenceField();
      await writeReference(scope, scope.issueArtifactId);

      // The stored column is what would go stale. It must stay empty, so that
      // even a reader that bypassed the strategy could not surface a cached
      // title.
      const row = await withDb((db) =>
        db.customFieldValue.findFirstOrThrow({
          where: {
            customFieldId: scope.fieldId,
            entityId: scope.ownerDocumentId,
          },
          select: { displayValue: true },
        })
      );
      expect(row.displayValue).toBe("");
    });
  });

  it("leaves no dangling reference row when the target artifact is deleted", async () => {
    await joinAmbientTransaction(async () => {
      const scope = await seedIssueReferenceField();
      await writeReference(scope, scope.issueArtifactId);

      expect(
        await withDb((db) =>
          db.customFieldValueReference.count({
            where: { targetArtifactId: scope.issueArtifactId },
          })
        )
      ).toBe(1);

      await withDb((db) =>
        db.artifact.delete({ where: { id: scope.issueArtifactId } })
      );

      // The FK cascade — not a cleanup job — is what makes this zero.
      expect(
        await withDb((db) =>
          db.customFieldValueReference.count({
            where: { targetArtifactId: scope.issueArtifactId },
          })
        )
      ).toBe(0);
    });
  });

  it("renders no phantom title after the referenced artifact is deleted", async () => {
    await joinAmbientTransaction(async () => {
      const scope = await seedIssueReferenceField();
      await writeReference(scope, scope.issueArtifactId);

      await withDb((db) =>
        db.artifact.delete({ where: { id: scope.issueArtifactId } })
      );

      const [value] = await readValues(scope);
      expect(value.referenceValues).toEqual([]);
      expect(value.displayValue).toBe("");
      expect(value.displayValue).not.toContain("Original issue title");
    });
  });
});
