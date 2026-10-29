import { ArtifactType } from "@repo/api/src/types/artifact";
import {
  CustomFieldEntityType,
  CustomFieldType,
} from "@repo/api/src/types/custom-field";
import { CustomFieldSortDirection } from "@repo/api/src/types/custom-field-list-query";
import { DocumentStatus, DocumentType } from "@repo/api/src/types/document";
import { withDb } from "@repo/database";
import { keys } from "@repo/database/keys";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestOrganization } from "@/__tests__/utils/db-helpers";
import { customFieldListService } from "./custom-field-list-service";

/**
 * Where the write path's EMPTY values land in a custom-field sort (ISS-7211
 * review, whitlockk).
 *
 * `NULLS LAST` orders NULLs, and the string columns hold a second spelling of
 * "unset" that is not NULL: `computeDisplayValue` returns `""` for a null raw
 * value, for an empty MULTI_ENUM or PEOPLE array, and for an ENUM whose option
 * was deleted, and a cleared text box round-trips as `""` in `text_value`. So
 * ascending order used to lead with every blank cell — precisely the rows a
 * reader expects at the END — while descending put them last, which made the
 * two directions disagree about what "unset" means.
 *
 * These cases need a real Postgres because the defect is entirely in where the
 * database puts a value: a mocked ordering would just replay the expectation.
 */

const hasDatabase = Boolean(keys().DATABASE_URL);
const describeIfDb = hasDatabase ? describe : describe.skip;

type SortFixture = {
  organizationId: string;
  textFieldId: string;
  multiEnumFieldId: string;
  /** Artifact carrying a real, sortable TEXT value. */
  alphaId: string;
  /** Artifact carrying a second real TEXT value, later in the collation. */
  zuluId: string;
  /** Artifact whose value row EXISTS but holds `""` — the bug's subject. */
  emptyStringId: string;
  /** Artifact with NO value row at all — the case `NULLS LAST` always covered. */
  missingId: string;
};

async function seedSortFixture(): Promise<SortFixture> {
  const organizationId = await createTestOrganization();

  const makeField = async (name: string, fieldType: CustomFieldType) =>
    await withDb((db) =>
      db.customField.create({
        data: {
          organizationId,
          name,
          fieldType,
          entityTypes: [CustomFieldEntityType.Document],
          showInTable: true,
          isSortable: true,
          isSearchable: true,
        },
        select: { id: true },
      })
    );

  const textField = await makeField("Owner", CustomFieldType.Text);
  const multiEnumField = await makeField("Tags", CustomFieldType.MultiEnum);

  const makeArtifact = async (name: string) => {
    const artifact = await withDb((db) =>
      db.artifact.create({
        data: {
          organizationId,
          type: ArtifactType.Document,
          subtype: DocumentType.Prd,
          name,
          status: DocumentStatus.Draft,
        },
        select: { id: true },
      })
    );
    return artifact.id;
  };

  const alphaId = await makeArtifact("alpha-doc");
  const zuluId = await makeArtifact("zulu-doc");
  const emptyStringId = await makeArtifact("empty-doc");
  const missingId = await makeArtifact("missing-doc");

  const setText = async (entityId: string, value: string) => {
    await withDb((db) =>
      db.customFieldValue.create({
        data: {
          customFieldId: textField.id,
          organizationId,
          entityType: CustomFieldEntityType.Document,
          entityId,
          textValue: value,
          displayValue: value,
          multiEnumValueIds: [],
          peopleValueIds: [],
        },
      })
    );
  };

  await setText(alphaId, "alpha");
  await setText(zuluId, "zulu");
  // The exact shape the write path produces for a cleared field: the row
  // survives, the value becomes "". NOT null.
  await setText(emptyStringId, "");

  // MULTI_ENUM sorts on `display_value`, and an empty selection caches "" there.
  const setTags = async (entityId: string, ids: string[], display: string) => {
    await withDb((db) =>
      db.customFieldValue.create({
        data: {
          customFieldId: multiEnumField.id,
          organizationId,
          entityType: CustomFieldEntityType.Document,
          entityId,
          multiEnumValueIds: ids,
          peopleValueIds: [],
          displayValue: display,
        },
      })
    );
  };
  await setTags(alphaId, ["11111111-1111-4111-8111-111111111111"], "Alpha Tag");
  await setTags(zuluId, ["22222222-2222-4222-8222-222222222222"], "Zulu Tag");
  await setTags(emptyStringId, [], "");

  return {
    organizationId,
    textFieldId: textField.id,
    multiEnumFieldId: multiEnumField.id,
    alphaId,
    zuluId,
    emptyStringId,
    missingId,
  };
}

async function dropSortFixture(organizationId: string): Promise<void> {
  await withDb(async (db) => {
    await db.customFieldValue.deleteMany({ where: { organizationId } });
    await db.customField.deleteMany({ where: { organizationId } });
    await db.artifact.deleteMany({ where: { organizationId } });
    await db.organization.delete({ where: { id: organizationId } });
  });
}

describeIfDb("custom-field sort and empty values (ISS-7211 review)", () => {
  let fixture: SortFixture;

  beforeAll(async () => {
    fixture = await seedSortFixture();
  });

  afterAll(async () => {
    if (fixture) {
      await dropSortFixture(fixture.organizationId);
    }
  });

  const orderBy = async (
    fieldId: string,
    fieldType: CustomFieldType,
    direction: (typeof CustomFieldSortDirection)[keyof typeof CustomFieldSortDirection],
    candidateIds: string[]
  ): Promise<string[]> =>
    await customFieldListService.orderIdsByCustomField(
      candidateIds,
      { id: fieldId, fieldType, isSortable: true, isSearchable: true },
      { fieldId, direction },
      CustomFieldEntityType.Document,
      fixture.organizationId,
      undefined,
      0
    );

  it("sorts an empty TEXT value to the END ascending, beside the missing row", async () => {
    // THE BUG: `''` collates before every non-empty string, so ascending used to
    // return [empty, missing?, alpha, zulu] — a screen of blanks at the top of a
    // list the user asked to sort by Owner.
    const ordered = await orderBy(
      fixture.textFieldId,
      CustomFieldType.Text,
      CustomFieldSortDirection.Asc,
      [
        fixture.zuluId,
        fixture.emptyStringId,
        fixture.alphaId,
        fixture.missingId,
      ]
    );

    expect(ordered.slice(0, 2)).toEqual([fixture.alphaId, fixture.zuluId]);
    // The empty row and the absent row are now the same kind of "unset" and both
    // land in the trailing group.
    expect(ordered.slice(2).sort()).toEqual(
      [fixture.emptyStringId, fixture.missingId].sort()
    );
  });

  it("keeps the empty TEXT value at the END descending too", async () => {
    // Both directions must agree about what "unset" means. `NULLS LAST` is
    // pinned in both directions already; this proves `''` now obeys it.
    const ordered = await orderBy(
      fixture.textFieldId,
      CustomFieldType.Text,
      CustomFieldSortDirection.Desc,
      [
        fixture.alphaId,
        fixture.emptyStringId,
        fixture.zuluId,
        fixture.missingId,
      ]
    );

    expect(ordered.slice(0, 2)).toEqual([fixture.zuluId, fixture.alphaId]);
    expect(ordered.slice(2).sort()).toEqual(
      [fixture.emptyStringId, fixture.missingId].sort()
    );
  });

  it("sorts an empty MULTI_ENUM selection to the END ascending", async () => {
    // MULTI_ENUM and PEOPLE have no scalar to order by and sort on the cached
    // `display_value`, which an empty selection sets to "" — so they carried the
    // same defect through a different column.
    const ordered = await orderBy(
      fixture.multiEnumFieldId,
      CustomFieldType.MultiEnum,
      CustomFieldSortDirection.Asc,
      [fixture.zuluId, fixture.emptyStringId, fixture.alphaId]
    );

    expect(ordered).toEqual([
      fixture.alphaId,
      fixture.zuluId,
      fixture.emptyStringId,
    ]);
  });
});
