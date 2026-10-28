import { ArtifactType } from "@repo/api/src/types/artifact";
import {
  CustomFieldEntityType,
  CustomFieldType,
  ReferenceTargetSource,
} from "@repo/api/src/types/custom-field";
import {
  CustomFieldFilterOperator,
  CustomFieldQueryRejection,
  CustomFieldSortDirection,
} from "@repo/api/src/types/custom-field-list-query";
import { DocumentStatus, DocumentType } from "@repo/api/src/types/document";
import type { User } from "@repo/api/src/types/user";
import { withDb } from "@repo/database";
import { keys } from "@repo/database/keys";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  createTestOrganization,
  createTestUser,
} from "@/__tests__/utils/db-helpers";

/**
 * DB-backed coverage for custom-field filtering and sorting in the document
 * list query (ISS-7211). Real Postgres via `withDb`; self-skips when
 * DATABASE_URL is unset.
 *
 * The cases here are the ones a unit test cannot honestly make: whether a
 * `count()` returns an ENTITY count when entities carry several values, where
 * Postgres actually puts NULLs when the direction flips, and whether the
 * capability flags stop a crafted request at the ROUTE rather than in the
 * toolbar. Each names the wrong behavior it exists to catch.
 *
 * Fixtures are created outside a rollback transaction and torn down explicitly,
 * because the route under test opens its own `RepeatableRead` transaction and
 * would not see uncommitted rows.
 */

const hasDatabase = Boolean(keys().DATABASE_URL);
const describeIfDb = hasDatabase ? describe : describe.skip;

let mockUser: User;

vi.mock("@/lib/auth/with-any-auth", () => ({
  withAnyAuth:
    (handler: (context: unknown, request: Request) => unknown) =>
    (request: Request) =>
      handler(
        { user: mockUser, authMethod: "session", clerkUserId: "clerk_test" },
        request
      ),
}));

type Fixture = {
  organizationId: string;
  user: User;
  artifactIds: string[];
  enumFieldId: string;
  /** Option ids in DECLARED (sortOrder) order, which is not id order. */
  optionIdsInDeclaredOrder: string[];
  textFieldId: string;
  unsortableFieldId: string;
  unsearchableFieldId: string;
  /** A REFERENCE field granted `isSortable`, to prove the type-level refusal. */
  sortableReferenceFieldId: string;
  noiseFieldIds: string[];
};

/**
 * Seed one organization whose artifacts each carry SEVERAL custom-field values.
 *
 * The several-values-per-entity shape is the point: it is what makes a join
 * against the tall value table report one entity as many rows, so a fixture with
 * one value per entity would let the multiplication bug pass unnoticed.
 *
 * The ENUM options are created so that their DECLARED order disagrees with their
 * id order — "Zulu" is inserted first (so it has the lowest `uuid(7)`) but is
 * declared third. A test whose option order happened to match id order would
 * pass whether the sort read `sort_order` or `enum_value_id`, and prove nothing.
 */
async function seedFixture(): Promise<Fixture> {
  const organizationId = await createTestOrganization();
  const user = await createTestUser(organizationId);

  const makeField = async (
    name: string,
    fieldType: CustomFieldType,
    flags: { isSortable: boolean; isSearchable: boolean }
  ) =>
    await withDb((db) =>
      db.customField.create({
        data: {
          organizationId,
          name,
          fieldType,
          entityTypes: [CustomFieldEntityType.Document],
          showInTable: true,
          isSortable: flags.isSortable,
          isSearchable: flags.isSearchable,
        },
        select: { id: true },
      })
    );

  const enabled = { isSortable: true, isSearchable: true };
  const enumField = await makeField("Priority", CustomFieldType.Enum, enabled);
  const textField = await makeField("Owner", CustomFieldType.Text, enabled);
  const unsortable = await makeField("Locked Sort", CustomFieldType.Text, {
    isSortable: false,
    isSearchable: true,
  });
  const unsearchable = await makeField("Locked Filter", CustomFieldType.Text, {
    isSortable: true,
    isSearchable: false,
  });
  // `isSortable: true` DELIBERATELY. A reference has no column to order by, so
  // the type-level refusal must hold even when an admin has granted the flag —
  // which is exactly the case a flag-only gate would let through.
  const sortableReference = await withDb((db) =>
    db.customField.create({
      data: {
        organizationId,
        name: "Linked Issue",
        fieldType: CustomFieldType.Reference,
        entityTypes: [CustomFieldEntityType.Document],
        referenceTargetSources: [ReferenceTargetSource.Artifact],
        showInTable: true,
        isSortable: true,
        isSearchable: true,
      },
      select: { id: true },
    })
  );
  // Extra fields exist only so each artifact carries MORE THAN ONE value row.
  const noise = await Promise.all([
    makeField("Noise A", CustomFieldType.Text, enabled),
    makeField("Noise B", CustomFieldType.Number, enabled),
  ]);

  // Insert in an order that deliberately disagrees with the declared order.
  const zulu = await createOption(enumField.id, "Zulu", 3);
  const alpha = await createOption(enumField.id, "Alpha", 1);
  const marisol = await createOption(enumField.id, "Marisol", 2);

  const artifactIds: string[] = [];
  for (let i = 0; i < 4; i++) {
    const artifact = await withDb((db) =>
      db.artifact.create({
        data: {
          organizationId,
          type: ArtifactType.Document,
          subtype: DocumentType.Prd,
          name: `Doc ${i}`,
          status: DocumentStatus.Draft,
          createdById: user.id,
        },
        select: { id: true },
      })
    );
    artifactIds.push(artifact.id);
  }

  // Artifacts 0..2 get an ENUM value; artifact 3 deliberately gets NONE, so the
  // null-ordering and "is empty" cases have a subject.
  await setEnumValue(enumField.id, organizationId, artifactIds[0], zulu);
  await setEnumValue(enumField.id, organizationId, artifactIds[1], alpha);
  await setEnumValue(enumField.id, organizationId, artifactIds[2], marisol);

  // Every artifact also carries values on the text and noise fields, so each
  // entity has FOUR value rows in total.
  for (const [index, artifactId] of artifactIds.entries()) {
    await setTextValue(
      textField.id,
      organizationId,
      artifactId,
      `owner-${index}`
    );
    await setTextValue(noise[0].id, organizationId, artifactId, "noise");
    await withDb((db) =>
      db.customFieldValue.create({
        data: {
          customFieldId: noise[1].id,
          organizationId,
          entityType: CustomFieldEntityType.Document,
          entityId: artifactId,
          numberValue: index,
          displayValue: String(index),
          ...EMPTY_SET_COLUMNS,
        },
      })
    );
  }

  return {
    organizationId,
    user,
    artifactIds,
    enumFieldId: enumField.id,
    optionIdsInDeclaredOrder: [alpha, marisol, zulu],
    textFieldId: textField.id,
    unsortableFieldId: unsortable.id,
    unsearchableFieldId: unsearchable.id,
    sortableReferenceFieldId: sortableReference.id,
    noiseFieldIds: noise.map((field) => field.id),
  };
}

async function createOption(
  customFieldId: string,
  name: string,
  sortOrder: number
): Promise<string> {
  const option = await withDb((db) =>
    db.customFieldEnumOption.create({
      data: { customFieldId, name, sortOrder },
      select: { id: true },
    })
  );
  return option.id;
}

/**
 * `multiEnumValueIds` and `peopleValueIds` are NOT NULL with no database
 * default, so every insert must state them even when the field's type does not
 * use them. Centralized here so a fixture cannot forget one.
 */
const EMPTY_SET_COLUMNS: {
  multiEnumValueIds: string[];
  peopleValueIds: string[];
} = {
  multiEnumValueIds: [],
  peopleValueIds: [],
};

function setEnumValue(
  customFieldId: string,
  organizationId: string,
  entityId: string,
  enumValueId: string
) {
  return withDb((db) =>
    db.customFieldValue.create({
      data: {
        customFieldId,
        organizationId,
        entityType: CustomFieldEntityType.Document,
        entityId,
        enumValueId,
        displayValue: enumValueId,
        ...EMPTY_SET_COLUMNS,
      },
    })
  );
}

function setTextValue(
  customFieldId: string,
  organizationId: string,
  entityId: string,
  textValue: string
) {
  return withDb((db) =>
    db.customFieldValue.create({
      data: {
        customFieldId,
        organizationId,
        entityType: CustomFieldEntityType.Document,
        entityId,
        textValue,
        displayValue: textValue,
        ...EMPTY_SET_COLUMNS,
      },
    })
  );
}

async function dropFixture(organizationId: string): Promise<void> {
  await withDb(async (db) => {
    await db.customFieldValue.deleteMany({ where: { organizationId } });
    await db.customFieldEnumOption.deleteMany({
      where: { customField: { organizationId } },
    });
    await db.customField.deleteMany({ where: { organizationId } });
    await db.artifact.deleteMany({ where: { organizationId } });
    await db.user.deleteMany({ where: { organizationId } });
    await db.organization.delete({ where: { id: organizationId } });
  });
}

/** Drive the real `GET /documents` handler with the given query string. */
async function callDocumentsRoute(
  query: Record<string, string>
): Promise<{ status: number; body: Record<string, unknown> }> {
  const { GET } = await import("./route");
  const { NextRequest } = await import("next/server");
  const url = new URL("http://localhost:3002/documents");
  for (const [key, value] of Object.entries(query)) {
    url.searchParams.set(key, value);
  }
  const response = (await GET(
    new NextRequest(url, { method: "GET" }) as never,
    undefined as never
  )) as Response;
  return { status: response.status, body: await response.json() };
}

describeIfDb("custom-field list queries (ISS-7211)", () => {
  let fixture: Fixture;

  beforeEach(async () => {
    fixture = await seedFixture();
    mockUser = fixture.user;
    return async () => {
      await dropFixture(fixture.organizationId);
    };
  });

  describe("totals and pagination", () => {
    it("reports the ENTITY count, not the value-row count, when a filtered entity carries several values", async () => {
      // Every artifact in this fixture carries FOUR custom-field value rows. A
      // list query that filters by joining the tall value table would count
      // those rows, and the single matching artifact would be reported as a
      // total of 4 (or 2 after the field predicate). Expressing the facet as a
      // constraint on `Artifact.id` is what keeps the count an entity count.
      const { status, body } = await callDocumentsRoute({
        includeTotal: "true",
        limit: "25",
        customFieldFilters: JSON.stringify([
          {
            fieldId: fixture.textFieldId,
            operator: CustomFieldFilterOperator.IsAnyOf,
            values: ["owner-1"],
          },
        ]),
      });

      expect(status).toBe(200);
      const page = body.data as { items: { id: string }[]; total: number };
      expect(page.total).toBe(1);
      expect(page.items).toHaveLength(1);
      expect(page.items[0].id).toBe(fixture.artifactIds[1]);
    });

    it("returns each entity exactly once when sorting a list whose entities carry several values", async () => {
      // The join-multiplication trap in the SORT path: the value join must pin
      // custom_field_id (and entity_type), or each artifact joins to all four of
      // its value rows and appears four times in one page.
      const { status, body } = await callDocumentsRoute({
        includeTotal: "true",
        limit: "25",
        customFieldSortId: fixture.enumFieldId,
        customFieldSortDir: CustomFieldSortDirection.Asc,
      });

      expect(status).toBe(200);
      const page = body.data as { items: { id: string }[]; total: number };
      const ids = page.items.map((item) => item.id);
      expect(new Set(ids).size).toBe(ids.length);
      expect(ids).toHaveLength(fixture.artifactIds.length);
      expect(page.total).toBe(fixture.artifactIds.length);
    });

    it("pages a custom-field-sorted list against the filtered total", async () => {
      const firstPage = await callDocumentsRoute({
        includeTotal: "true",
        limit: "2",
        offset: "0",
        customFieldSortId: fixture.enumFieldId,
        customFieldSortDir: CustomFieldSortDirection.Asc,
      });
      const secondPage = await callDocumentsRoute({
        includeTotal: "true",
        limit: "2",
        offset: "2",
        customFieldSortId: fixture.enumFieldId,
        customFieldSortDir: CustomFieldSortDirection.Asc,
      });

      const first = firstPage.body.data as {
        items: { id: string }[];
        total: number;
        hasMore: boolean;
      };
      const second = secondPage.body.data as {
        items: { id: string }[];
        total: number;
        hasMore: boolean;
      };
      expect(first.total).toBe(4);
      expect(first.hasMore).toBe(true);
      expect(second.hasMore).toBe(false);
      // The two pages must partition the set — no row served twice, none lost.
      const seen = [...first.items, ...second.items].map((item) => item.id);
      expect(new Set(seen).size).toBe(4);
    });
  });

  describe("ENUM ordering", () => {
    it("orders by the option's declared order, not by the option id", async () => {
      // The fixture's options were INSERTED Zulu, Alpha, Marisol (so that is their
      // uuid(7) order) but DECLARED Alpha(1), Marisol(2), Zulu(3). Sorting by
      // `enum_value_id` would yield Zulu, Alpha, Marisol; only reading the option's
      // `sort_order` yields the declared order asserted here.
      const { body } = await callDocumentsRoute({
        includeTotal: "true",
        limit: "25",
        customFieldSortId: fixture.enumFieldId,
        customFieldSortDir: CustomFieldSortDirection.Asc,
      });
      const page = body.data as { items: { id: string }[] };
      const valued = page.items
        .map((item) => item.id)
        .filter((id) => id !== fixture.artifactIds[3]);

      expect(valued).toEqual([
        fixture.artifactIds[1], // Alpha, declared first, inserted second
        fixture.artifactIds[2], // Marisol, declared second, inserted third
        fixture.artifactIds[0], // Zulu, declared third, inserted FIRST
      ]);
    });
  });

  describe("null ordering", () => {
    it("puts the value-less entity last when ascending", async () => {
      const { body } = await callDocumentsRoute({
        includeTotal: "true",
        limit: "25",
        customFieldSortId: fixture.enumFieldId,
        customFieldSortDir: CustomFieldSortDirection.Asc,
      });
      const ids = (body.data as { items: { id: string }[] }).items.map(
        (item) => item.id
      );
      expect(ids.at(-1)).toBe(fixture.artifactIds[3]);
    });

    it("STILL puts the value-less entity last when descending", async () => {
      // This is the case an unpinned ordering gets wrong. Postgres defaults to
      // NULLS FIRST for DESC, so without the explicit `NULLS LAST` the empty row
      // would jump to the TOP the moment the user flips the direction — and the
      // ascending test above would still pass, hiding it.
      const { body } = await callDocumentsRoute({
        includeTotal: "true",
        limit: "25",
        customFieldSortId: fixture.enumFieldId,
        customFieldSortDir: CustomFieldSortDirection.Desc,
      });
      const ids = (body.data as { items: { id: string }[] }).items.map(
        (item) => item.id
      );
      expect(ids.at(-1)).toBe(fixture.artifactIds[3]);
      // And the direction genuinely reversed the VALUED rows.
      expect(ids[0]).toBe(fixture.artifactIds[0]);
    });
  });

  describe("emptiness facets", () => {
    it("matches the entity that never had a value row for the field", async () => {
      // Artifact 3 has no ENUM value row at all. A predicate that looked for
      // rows whose column IS NULL would find nothing and return an empty list.
      const { body } = await callDocumentsRoute({
        includeTotal: "true",
        limit: "25",
        customFieldFilters: JSON.stringify([
          {
            fieldId: fixture.enumFieldId,
            operator: CustomFieldFilterOperator.IsEmpty,
          },
        ]),
      });
      const page = body.data as { items: { id: string }[]; total: number };
      expect(page.total).toBe(1);
      expect(page.items[0].id).toBe(fixture.artifactIds[3]);
    });

    it("is the exact complement of is-not-empty", async () => {
      const { body } = await callDocumentsRoute({
        includeTotal: "true",
        limit: "25",
        customFieldFilters: JSON.stringify([
          {
            fieldId: fixture.enumFieldId,
            operator: CustomFieldFilterOperator.IsNotEmpty,
          },
        ]),
      });
      const page = body.data as { items: { id: string }[]; total: number };
      expect(page.total).toBe(3);
      expect(page.items.map((item) => item.id)).not.toContain(
        fixture.artifactIds[3]
      );
    });
  });

  describe("multi-facet semantics", () => {
    it("ANDs across facets", async () => {
      const { body } = await callDocumentsRoute({
        includeTotal: "true",
        limit: "25",
        customFieldFilters: JSON.stringify([
          {
            fieldId: fixture.enumFieldId,
            operator: CustomFieldFilterOperator.IsNotEmpty,
          },
          {
            fieldId: fixture.textFieldId,
            operator: CustomFieldFilterOperator.IsAnyOf,
            values: ["owner-0", "owner-3"],
          },
        ]),
      });
      const page = body.data as { items: { id: string }[]; total: number };
      // owner-3 has no enum value, so only owner-0 survives both facets.
      expect(page.total).toBe(1);
      expect(page.items[0].id).toBe(fixture.artifactIds[0]);
    });

    it("returns an empty page when a facet matches nothing, not the whole list", async () => {
      // An empty include set must not be collapsed to "no filter".
      const { body } = await callDocumentsRoute({
        includeTotal: "true",
        limit: "25",
        customFieldFilters: JSON.stringify([
          {
            fieldId: fixture.textFieldId,
            operator: CustomFieldFilterOperator.IsAnyOf,
            values: ["nobody-owns-this"],
          },
        ]),
      });
      const page = body.data as { items: { id: string }[]; total: number };
      expect(page.total).toBe(0);
      expect(page.items).toHaveLength(0);
    });
  });

  describe("capability flags are enforced server-side", () => {
    it("refuses to sort by a field whose isSortable is false", async () => {
      // The toolbar never offers this column, but the toolbar is not the only
      // thing that can send the request. Driving the real route with a crafted
      // `customFieldSortId` is the point of this case.
      const { status, body } = await callDocumentsRoute({
        includeTotal: "true",
        limit: "25",
        customFieldSortId: fixture.unsortableFieldId,
        customFieldSortDir: CustomFieldSortDirection.Asc,
      });
      expect(status).toBe(400);
      expect(body.error).toBe(CustomFieldQueryRejection.NotSortable);
    });

    it("refuses to sort by a REFERENCE field even when isSortable is true", async () => {
      // The regression this pins: a reference caches no display string
      // (ISS-7214) and keeps its targets in a side table, so there is no column
      // to order by. Serving the request would ORDER BY a value that is empty
      // for every reference row — 200 OK, rows back, creation order under the
      // user's chosen column. Refusing is the only honest answer until a target
      // attribute and a multi-value reduction are actually chosen.
      const { status, body } = await callDocumentsRoute({
        includeTotal: "true",
        limit: "25",
        customFieldSortId: fixture.sortableReferenceFieldId,
        customFieldSortDir: CustomFieldSortDirection.Asc,
      });
      expect(status).toBe(400);
      expect(body.error).toBe(CustomFieldQueryRejection.NotSortable);
    });

    it("refuses to filter by a field whose isSearchable is false", async () => {
      const { status, body } = await callDocumentsRoute({
        includeTotal: "true",
        limit: "25",
        customFieldFilters: JSON.stringify([
          {
            fieldId: fixture.unsearchableFieldId,
            operator: CustomFieldFilterOperator.IsNotEmpty,
          },
        ]),
      });
      expect(status).toBe(400);
      expect(body.error).toBe(CustomFieldQueryRejection.NotFilterable);
    });

    it("still allows the sortable-but-unfilterable field to be SORTED", async () => {
      // Guards the opposite error: refusing everything would also pass the two
      // rejection tests above while breaking the feature.
      const { status } = await callDocumentsRoute({
        includeTotal: "true",
        limit: "25",
        customFieldSortId: fixture.unsearchableFieldId,
        customFieldSortDir: CustomFieldSortDirection.Asc,
      });
      expect(status).toBe(200);
    });

    it("refuses a field belonging to another organization as unknown", async () => {
      // Org scoping: a cross-org field id must be indistinguishable from a
      // nonexistent one, never leak that it exists, and never be sortable.
      const otherOrgId = await createTestOrganization();
      const foreignField = await withDb((db) =>
        db.customField.create({
          data: {
            organizationId: otherOrgId,
            name: "Foreign",
            fieldType: CustomFieldType.Text,
            entityTypes: [CustomFieldEntityType.Document],
            isSortable: true,
            isSearchable: true,
          },
          select: { id: true },
        })
      );

      const { status, body } = await callDocumentsRoute({
        includeTotal: "true",
        limit: "25",
        customFieldSortId: foreignField.id,
        customFieldSortDir: CustomFieldSortDirection.Asc,
      });

      expect(status).toBe(400);
      expect(body.error).toBe(CustomFieldQueryRejection.UnknownField);
      await dropFixture(otherOrgId);
    });
  });
});
