import { ArtifactType } from "@repo/api/src/types/artifact";
import {
  CustomFieldEntityType,
  CustomFieldType,
} from "@repo/api/src/types/custom-field";
import {
  CUSTOM_FIELD_FILTER_MAX_MATCHED_ENTITIES,
  CustomFieldFilterOperator,
  CustomFieldQueryRejection,
} from "@repo/api/src/types/custom-field-list-query";
import { DocumentStatus, DocumentType } from "@repo/api/src/types/document";
import type { User } from "@repo/api/src/types/user";
import { Prisma, withDb } from "@repo/database";
import { keys } from "@repo/database/keys";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  createTestOrganization,
  createTestUser,
} from "@/__tests__/utils/db-helpers";
import { buildDocumentListWhere } from "./document-list-query";

/**
 * The bounds half of ISS-7211, at the scale the bounds exist for.
 *
 * Every case here needs a population LARGER than a bound, so none of them can be
 * written against the four-artifact fixture in
 * `custom-field-list.integration.test.ts` — a three-row fixture cannot prove a
 * 32767-parameter cliff. They seed tens of thousands of rows through one bulk
 * statement each and share a single organization.
 *
 * All four were review findings on the original implementation (whitlockk,
 * tamsinb), and each names the concrete wrong behavior it exists to catch.
 */

const hasDatabase = Boolean(keys().DATABASE_URL);
const describeIfDb = hasDatabase ? describe : describe.skip;

/**
 * Prisma's Postgres driver encodes a statement's parameter count as a signed
 * 16-bit integer, so the real ceiling is 32767 — NOT the 65535 the Postgres wire
 * protocol documents. Measured against this schema while fixing the finding:
 * 20001 ids in a `notIn` succeed, 32766 already fail with "The query parameter
 * limit supported by your database is exceeded."
 *
 * This matters to the fix: the per-facet bound of 20000 meant TWO disjoint
 * `isEmpty` facets were already over the cliff, not the four whitlockk estimated
 * against the documented 65535.
 */
const PRISMA_BIND_CEILING = 32_767;

/** Enough entities on each of two disjoint facets to exceed that ceiling when unioned. */
const FACET_SIZE = CUSTOM_FIELD_FILTER_MAX_MATCHED_ENTITIES;

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

type BoundsFixture = {
  organizationId: string;
  user: User;
  /** Values on artifacts 0..FACET_SIZE-1. */
  facetAFieldId: string;
  /** Values on artifacts FACET_SIZE..2*FACET_SIZE-1 — disjoint from A. */
  facetBFieldId: string;
  /** One popular value spread over more entities than the bound allows. */
  popularFieldId: string;
  /** A TEXT field used only as a sort target — no values, so ordering is all-NULL. */
  sortFieldId: string;
  /** A keep-facet small enough to stay inside the per-facet bound. */
  smallKeepFieldId: string;
  /** The handful of PRD-subtype artifacts every narrowed query targets. */
  narrowArtifactIds: string[];
};

const POPULAR_VALUE = "popular";
/** The value the small keep-facet holds, on the narrow artifacts and nothing else. */
const SMALL_KEEP_VALUE = "keep";
const NARROW_COUNT = 5;

/**
 * Seed one organization large enough to cross every bound.
 *
 * Bulk `INSERT … SELECT generate_series(…)` rather than per-row Prisma creates:
 * this fixture is ~40000 artifacts and ~60000 value rows, and a per-row loop
 * would take minutes and time the suite out. It is also the shape
 * `apps/api/AGENTS.md` asks for — one set-based statement, not a per-item loop.
 */
async function seedBoundsFixture(): Promise<BoundsFixture> {
  const organizationId = await createTestOrganization();
  const user = await createTestUser(organizationId);

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

  const facetA = await makeField("Facet A", CustomFieldType.Text);
  const facetB = await makeField("Facet B", CustomFieldType.Text);
  const popular = await makeField("Popular", CustomFieldType.Text);
  const sortField = await makeField("Sort Me", CustomFieldType.Text);
  const smallKeep = await makeField("Small Keep", CustomFieldType.Text);

  // The bulk population: FEATURE-subtype artifacts nobody narrows to.
  await withDb((db) =>
    db.$executeRaw(Prisma.sql`
      INSERT INTO artifacts (id, organization_id, type, subtype, name, status, created_at, updated_at)
      SELECT
        gen_random_uuid(),
        ${organizationId}::uuid,
        ${ArtifactType.Document}::"ArtifactType",
        ${DocumentType.Feature}::"ArtifactSubtype",
        'bulk-' || g,
        ${DocumentStatus.Draft},
        now(),
        now()
      FROM generate_series(1, ${FACET_SIZE * 2}) g
    `)
  );

  // The narrow target: a handful of PRD-subtype artifacts. `type=PRD` is the
  // scoping predicate every "narrowing should work" case below applies.
  const narrowArtifactIds: string[] = [];
  for (let i = 0; i < NARROW_COUNT; i++) {
    const artifact = await withDb((db) =>
      db.artifact.create({
        data: {
          organizationId,
          type: ArtifactType.Document,
          subtype: DocumentType.Prd,
          name: `narrow-${i}`,
          status: DocumentStatus.Draft,
          createdById: user.id,
        },
        select: { id: true },
      })
    );
    narrowArtifactIds.push(artifact.id);
  }

  const bulkIds = await withDb((db) =>
    db.artifact.findMany({
      where: { organizationId, subtype: DocumentType.Feature },
      select: { id: true },
      orderBy: { name: "asc" },
    })
  );

  // Facets A and B cover DISJOINT halves, so their `isEmpty` exclusion sets
  // union rather than overlap — the shape that defeats a per-facet bound.
  await insertTextValues(
    facetA.id,
    organizationId,
    bulkIds.slice(0, FACET_SIZE).map((row) => row.id),
    "a"
  );
  await insertTextValues(
    facetB.id,
    organizationId,
    bulkIds.slice(FACET_SIZE).map((row) => row.id),
    "b"
  );

  // The popular value: over the bound org-wide, but only NARROW_COUNT of them
  // sit inside the PRD subtype a narrowed request asks for.
  await insertTextValues(
    popular.id,
    organizationId,
    bulkIds
      .slice(0, CUSTOM_FIELD_FILTER_MAX_MATCHED_ENTITIES + 1)
      .map((row) => row.id),
    POPULAR_VALUE
  );
  await insertTextValues(
    popular.id,
    organizationId,
    narrowArtifactIds,
    POPULAR_VALUE
  );

  // A keep-facet deliberately INSIDE the per-facet bound, so the mixed-operator
  // case below exercises the set-difference path rather than a refusal.
  await insertTextValues(
    smallKeep.id,
    organizationId,
    narrowArtifactIds,
    SMALL_KEEP_VALUE
  );

  return {
    organizationId,
    user,
    facetAFieldId: facetA.id,
    facetBFieldId: facetB.id,
    popularFieldId: popular.id,
    sortFieldId: sortField.id,
    smallKeepFieldId: smallKeep.id,
    narrowArtifactIds,
  };
}

/** Bulk-insert one TEXT value per entity id, in a single statement. */
async function insertTextValues(
  customFieldId: string,
  organizationId: string,
  entityIds: string[],
  value: string
): Promise<void> {
  if (entityIds.length === 0) {
    return;
  }
  await withDb((db) =>
    db.$executeRaw(Prisma.sql`
      INSERT INTO custom_field_values (
        id, custom_field_id, organization_id, entity_type, entity_id,
        text_value, display_value, multi_enum_value_ids, people_value_ids, updated_at
      )
      SELECT
        gen_random_uuid(),
        ${customFieldId}::uuid,
        ${organizationId}::uuid,
        ${CustomFieldEntityType.Document}::"CustomFieldEntityType",
        entity_id,
        ${value},
        ${value},
        '{}',
        '{}',
        now()
      FROM unnest(${entityIds}::uuid[]) AS entity_id
      ON CONFLICT (custom_field_id, entity_type, entity_id) DO NOTHING
    `)
  );
}

async function dropBoundsFixture(organizationId: string): Promise<void> {
  await withDb(async (db) => {
    await db.customFieldValue.deleteMany({ where: { organizationId } });
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

function encodeFilters(
  filters: { fieldId: string; operator: string; values?: string[] }[]
): string {
  return JSON.stringify(filters);
}

describeIfDb("custom-field list query bounds (ISS-7211 review)", () => {
  let fixture: BoundsFixture;

  beforeAll(async () => {
    fixture = await seedBoundsFixture();
    mockUser = fixture.user;
  });

  afterAll(async () => {
    if (fixture) {
      await dropBoundsFixture(fixture.organizationId);
    }
  });

  describe("the aggregate id constraint (whitlockk, tamsinb)", () => {
    it("bounds the union of two disjoint isEmpty facets instead of binding 40000 ids", async () => {
      // THE BUG: each facet was bounded at 20000 but the exclusion sets UNION,
      // so two disjoint facets handed `id.notIn` 40000 entity ids — past the
      // 32767 the driver can bind. It did not run slowly; it failed with an
      // opaque "query parameter limit exceeded" surfacing as a 500.
      //
      // Prove the fixture is genuinely over the cliff, then prove the resolved
      // constraint is either refused or small enough to execute — never a
      // 40000-parameter statement.
      const matched = await withDb((db) =>
        db.customFieldValue.count({
          where: {
            organizationId: fixture.organizationId,
            customFieldId: {
              in: [fixture.facetAFieldId, fixture.facetBFieldId],
            },
          },
        })
      );
      expect(matched).toBeGreaterThan(PRISMA_BIND_CEILING);

      const { customFieldListService } = await import(
        "./custom-field-list-service"
      );
      const constraint = await customFieldListService.resolveFilters(
        [
          {
            fieldId: fixture.facetAFieldId,
            operator: CustomFieldFilterOperator.IsEmpty,
          },
          {
            fieldId: fixture.facetBFieldId,
            operator: CustomFieldFilterOperator.IsEmpty,
          },
        ],
        fixture.organizationId
      );

      // With no scoped population to fall back on, an over-bound union is a
      // stated refusal rather than a doomed statement.
      expect(constraint.ok).toBe(false);
      if (constraint.ok) {
        return;
      }
      expect(constraint.error).toBe(CustomFieldQueryRejection.FilterTooBroad);
    });

    it("answers those same two facets end to end once the request narrows", async () => {
      // The union is re-expressed as the KEPT ids inside the scoped population,
      // so a request whose own narrowing made the population small is answered.
      // Against the unfixed code this same call throws the parameter-limit error
      // and returns a 500, because the 40000-id `notIn` reaches Postgres.
      const { status, body } = await callDocumentsRoute({
        type: DocumentType.Prd,
        limit: "50",
        includeTotal: "true",
        customFieldFilters: encodeFilters([
          {
            fieldId: fixture.facetAFieldId,
            operator: CustomFieldFilterOperator.IsEmpty,
          },
          {
            fieldId: fixture.facetBFieldId,
            operator: CustomFieldFilterOperator.IsEmpty,
          },
        ]),
      });

      expect(status).toBe(200);
      const page = body.data as { items: { id: string }[]; total: number };
      // None of the PRD artifacts carry a Facet A or Facet B value, so all of
      // them are "empty" on both.
      expect(page.total).toBe(NARROW_COUNT);
    });

    it("never emits a notIn when a keep-facet is present, however many isEmpty facets union", async () => {
      // The set difference is taken in Node against the already-bounded keep
      // set, so the exclusion never travels as bind parameters at all. A
      // regression that reinstated `notIn` here would reintroduce the cliff for
      // any request that mixes operators.
      const { customFieldListService } = await import(
        "./custom-field-list-service"
      );
      const constraint = await customFieldListService.resolveFilters(
        [
          {
            fieldId: fixture.smallKeepFieldId,
            operator: CustomFieldFilterOperator.IsAnyOf,
            values: ["keep"],
          },
          {
            fieldId: fixture.facetAFieldId,
            operator: CustomFieldFilterOperator.IsEmpty,
          },
          {
            fieldId: fixture.facetBFieldId,
            operator: CustomFieldFilterOperator.IsEmpty,
          },
        ],
        fixture.organizationId
      );

      expect(constraint.ok).toBe(true);
      if (!constraint.ok) {
        return;
      }
      expect(constraint.value.exclude).toEqual([]);
      expect(constraint.value.include).toHaveLength(NARROW_COUNT);
      expect(
        (constraint.value.include?.length ?? 0) +
          constraint.value.exclude.length
      ).toBeLessThanOrEqual(CUSTOM_FIELD_FILTER_MAX_MATCHED_ENTITIES);

      // And the constraint must actually EXECUTE — the whole point of bounding it.
      const total = await withDb((db) =>
        db.artifact.count({
          where: buildDocumentListWhere({
            organizationId: fixture.organizationId,
            customFieldEntityIds: constraint.value,
          }),
        })
      );
      expect(total).toBe(NARROW_COUNT);
    });
  });

  describe("the cap is measured on the scoped population (whitlockk)", () => {
    it("answers a five-row narrowed query against a value used past the org-wide cap", async () => {
      // THE BUG: the facet read counted matches ORG-WIDE and refused past 20000,
      // before the project/type/assignee/recency predicates ran. So a value used
      // on 20001 documents rejected a five-row `type=PRD` query — and the
      // refusal told the caller to narrow, which could not possibly help,
      // because narrowing does not change an org-wide count.
      const { status, body } = await callDocumentsRoute({
        type: DocumentType.Prd,
        limit: "50",
        includeTotal: "true",
        customFieldFilters: encodeFilters([
          {
            fieldId: fixture.popularFieldId,
            operator: CustomFieldFilterOperator.IsAnyOf,
            values: [POPULAR_VALUE],
          },
        ]),
      });

      expect(status).toBe(200);
      const page = body.data as { items: { id: string }[]; total: number };
      expect(page.total).toBe(NARROW_COUNT);
      expect(page.items).toHaveLength(NARROW_COUNT);
    });

    it("still refuses the same facet when the request narrows to nothing", async () => {
      // The bound is not gone, it moved. Un-narrowed, the scoped population IS
      // the org and the request is genuinely unanswerable — but now the reason
      // code's guidance is followable, because the case above proves narrowing
      // changes the verdict.
      const { status, body } = await callDocumentsRoute({
        limit: "50",
        includeTotal: "true",
        customFieldFilters: encodeFilters([
          {
            fieldId: fixture.popularFieldId,
            operator: CustomFieldFilterOperator.IsAnyOf,
            values: [POPULAR_VALUE],
          },
        ]),
      });

      expect(status).toBe(400);
      expect(body.error).toBe(CustomFieldQueryRejection.FilterTooBroad);
    });
  });

  describe("a bounded page stays a bounded read (whitlockk)", () => {
    it("refuses a custom-field sort whose scoped population is over the bound", async () => {
      // THE BUG: ordering by a column Prisma cannot reach meant the read loaded
      // EVERY matching artifact id into Node before paging, so `limit=1` became
      // an org-wide scan. It is now an admission check with a reason code.
      const { status, body } = await callDocumentsRoute({
        limit: "1",
        includeTotal: "true",
        customFieldSortId: fixture.sortFieldId,
      });

      expect(status).toBe(400);
      expect(body.error).toBe(CustomFieldQueryRejection.FilterTooBroad);
    });

    it("serves the same sort once the request narrows the population", async () => {
      const { status, body } = await callDocumentsRoute({
        type: DocumentType.Prd,
        limit: "1",
        includeTotal: "true",
        customFieldSortId: fixture.sortFieldId,
      });

      expect(status).toBe(200);
      const page = body.data as { items: { id: string }[]; total: number };
      expect(page.total).toBe(NARROW_COUNT);
      expect(page.items).toHaveLength(1);
    });

    it("serves the same sort when a CUSTOM-FIELD FILTER is the only thing narrowing the population", async () => {
      // THE BUG, REINTRODUCED ONE SCOPE OVER: the sort admission check consulted
      // the reader built for FILTER resolution, whose predicate deliberately
      // omits the custom-field slice (scoping a filter's resolution by that same
      // filter is circular) and is closed over at construction. By the time the
      // sort is checked the filters have already resolved, so folding them in is
      // no longer circular — but nothing did. So this request, which narrows to
      // NARROW_COUNT entities using the very filter feature this PR ships, was
      // measured against the unfiltered 40005-artifact org population and
      // refused with FilterTooBroad, telling the caller to "narrow your
      // request" when they already had. `findArtifactsOrderedByCustomField`
      // would have scanned NARROW_COUNT candidates.
      //
      // No built-in predicate is sent — no type, project, assignee, or recency
      // window — so the custom-field filter is the ONLY narrowing here. Drop it
      // and this request is the sibling case above, which must still 400.
      const { status, body } = await callDocumentsRoute({
        limit: "50",
        includeTotal: "true",
        customFieldSortId: fixture.sortFieldId,
        customFieldFilters: encodeFilters([
          {
            fieldId: fixture.smallKeepFieldId,
            operator: CustomFieldFilterOperator.IsAnyOf,
            values: [SMALL_KEEP_VALUE],
          },
        ]),
      });

      expect(status).toBe(200);
      const page = body.data as { items: { id: string }[]; total: number };
      expect(page.total).toBe(NARROW_COUNT);
      // The exact rows, not just the count: an admission check that let the
      // request through but ranked it against the wrong population would still
      // satisfy a bare length assertion.
      expect([...page.items.map((item) => item.id)].sort()).toEqual(
        [...fixture.narrowArtifactIds].sort()
      );
    });
  });
});
